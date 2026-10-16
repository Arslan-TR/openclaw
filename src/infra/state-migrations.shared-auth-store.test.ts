import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as ownership from "../agents/auth-profiles/path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../agents/auth-profiles/path-resolve.native.js";
import * as persisted from "../agents/auth-profiles/persisted.js";
import { setAuthProfileOrder } from "../agents/auth-profiles/profiles.js";
import * as paths from "../agents/auth-profiles/shared-main-dir.js";
import * as sqlite from "../agents/auth-profiles/sqlite.js";
import * as authState from "../agents/auth-profiles/state.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import { upsertAuthProfileWithLockOrThrow } from "../agents/auth-profiles/upsert-with-lock.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { EngineConnection } from "./sql-connection.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
import * as doctor from "./state-migrations.doctor.js";
import * as migration from "./state-migrations.shared-auth-store.js";

function row(db: EngineConnection, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).get(...params);
}
function rows(db: EngineConnection, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).all(...params);
}

function readSourceRow(db: EngineConnection, kind: "store" | "state") {
  return row(
    db,
    `SELECT ${kind}_json, updated_at FROM auth_profile_${kind} WHERE ${kind}_key = 'primary'`,
  );
}
function machineRow(db: EngineConnection, key: string, timestamps = false) {
  return row(
    db,
    `SELECT value_json${timestamps ? ", updated_at_ms" : ""} FROM config_machine_state WHERE state_key = ?`,
    key,
  );
}
function receiptRow(db: EngineConnection) {
  return row(
    db,
    "SELECT source_sha256, source_record_count, status, removed_source FROM migration_sources WHERE target_table = 'auth_profile_stores'",
  );
}
function count(db: EngineConnection, table: string, key: string, value: string) {
  return row(db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${key} = ?`, value)?.count;
}
function localAuth(agentDir: string) {
  return {
    store: sqlite.readPersistedAuthProfileStoreRaw(agentDir),
    state: sqlite.readPersistedAuthProfileStateRaw(agentDir),
  };
}
function sharedAuth(env: NodeJS.ProcessEnv) {
  return {
    store: sqlite.readPersistedSharedAuthProfileStoreRaw(env),
    state: sqlite.readPersistedSharedAuthProfileStateRaw(env),
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ownerStates: OpenClawTestState[] = [];
let ownerFixtureRun: Promise<void> | undefined;

function makeStore(profileId: string, key: string) {
  return {
    version: 1,
    profiles: {
      [profileId]: { type: "api_key" as const, provider: "openai", key },
    },
  };
}

describe("shared auth store relocation", () => {
  afterEach(async () => {
    // Timeouts leave the callback running; join it before resetting env or deleting its stores.
    await ownerFixtureRun?.catch(() => {});
    ownerFixtureRun = undefined;
    vi.restoreAllMocks();
    sqlite.closeAuthProfileReadPool();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await stateDb.closeOpenClawStateDatabaseAsync();
    stateDb.closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    for (const state of ownerStates.splice(0).toReversed()) {
      await state.cleanup();
      expect(fs.existsSync(state.root)).toBe(false);
    }
  });

  async function createFixture() {
    const fixture = await createEmptyFixture(false);
    const { stateDir, env } = fixture;
    const mainAgentDir = paths.resolveSharedMainAuthAgentDir(env);
    const opsAgentDir = path.join(stateDir, "agents", "ops", "agent");
    const sharedStore = makeStore("openai:shared", "shared-key");
    const sharedState = {
      version: 1,
      order: { openai: ["openai:shared"] },
      lastGood: { openai: "openai:shared" },
    };
    const opsStore = makeStore("openai:ops", "ops-key");
    sqlite.writePersistedAuthProfileStoreRaw(sharedStore, mainAgentDir);
    sqlite.writePersistedAuthProfileStateRaw(sharedState, mainAgentDir);
    sqlite.writePersistedAuthProfileStoreRaw(opsStore, opsAgentDir);
    return {
      ...fixture,
      mainAgentDir,
      opsAgentDir,
      sharedStore,
      sharedState,
    };
  }

  async function createEmptyFixture(createSourceDatabase: boolean) {
    const stateDir = tempDirs.make("openclaw-shared-auth-empty-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
    const mainAgentDir = paths.resolveSharedMainAuthAgentDir(env);
    const sourcePath = sqlite.resolveAuthProfileDatabasePath(mainAgentDir);
    if (createSourceDatabase) {
      sqlite.writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, mainAgentDir);
      sqlite.deletePersistedAuthProfileStoreRaw(mainAgentDir);
    }
    return {
      env,
      stateDir,
      sourcePath,
      detect: (
        overrides: Partial<Parameters<typeof migration.detectSharedAuthStoreMigration>[0]> = {},
      ) =>
        migration.detectSharedAuthStoreMigration({
          stateDir,
          doctorOnlyStateMigrations: true,
          ...overrides,
        }),
      migrate: (
        detected: Parameters<typeof migration.migrateSharedAuthStore>[0]["detected"],
        selectedEnv?: NodeJS.ProcessEnv,
      ) => migration.migrateSharedAuthStore({ detected, stateDir, env: selectedEnv }),
    };
  }

  it.each(["legacy-main", "state-db"])(
    "preserves copied auth SQLite artifacts during %s inspection",
    async (location) => {
      const fixture = await createEmptyFixture(false);
      const statePath = resolveOpenClawStateSqlitePath(fixture.env);
      const seedPath = path.join(tempDirs.make("openclaw-auth-wal-seed-"), "seed.sqlite");
      for (const target of [fixture.sourcePath, statePath]) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const seed = new DatabaseSync(seedPath);
        try {
          seed.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT, store_json TEXT, updated_at INTEGER);
            CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT, value_json TEXT, updated_at_ms INTEGER);
            CREATE TABLE IF NOT EXISTS migration_sources (source_key TEXT, migration_kind TEXT, source_path TEXT, removed_source INTEGER, source_sha256 TEXT, report_json TEXT);
            PRAGMA wal_checkpoint(TRUNCATE);
          `);
          if (target === fixture.sourcePath) {
            seed
              .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)")
              .run(JSON.stringify(makeStore("openai:copied", "fixture-key")));
          } else {
            seed.exec(
              extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "agent_deletion_journal"),
            );
            seed
              .prepare("INSERT INTO config_machine_state VALUES ('auth.sharedStore', ?, 1)")
              .run(JSON.stringify({ location }));
            seed
              .prepare(
                "INSERT INTO migration_sources (source_key, migration_kind, source_path, removed_source) VALUES ('pending', 'shared-auth-store-state-db', ?, 0)",
              )
              .run(fixture.sourcePath);
          }
          fs.copyFileSync(seedPath, target);
          fs.copyFileSync(`${seedPath}-wal`, `${target}-wal`);
        } finally {
          seed.close();
        }
      }
      const inventory = () =>
        [fixture.sourcePath, statePath].flatMap((file) =>
          ["", "-wal", "-shm", "-journal"].map((suffix) => ({
            path: `${file}${suffix}`,
            bytes: fs.existsSync(`${file}${suffix}`) ? fs.readFileSync(`${file}${suffix}`) : null,
          })),
        );
      const before = inventory();
      expect(fs.existsSync(`${fixture.sourcePath}-shm`)).toBe(false);
      expect(fs.existsSync(`${statePath}-shm`)).toBe(false);
      expect(fixture.detect({ env: fixture.env, artifactPreservingReadOnly: true })).toEqual({
        sourcePath: fixture.sourcePath,
        hasLegacy: true,
      });
      expect(inventory()).toEqual(before);
    },
  );

  it("does not pin runtime auth ownership during copied inspection", async () => {
    const fixture = await createEmptyFixture(false);
    expect(fixture.detect({ env: fixture.env, artifactPreservingReadOnly: true })).toEqual({
      sourcePath: fixture.sourcePath,
      hasLegacy: true,
    });
    const statePath = resolveOpenClawStateSqlitePath(fixture.env);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(ownership.getPreparedSharedAuthStoreOwnership(fixture.env)).toBeUndefined();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const database = new DatabaseSync(statePath);
    try {
      database.exec(`
        CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT, updated_at_ms INTEGER);
        INSERT INTO config_machine_state VALUES ('auth.sharedStore', '{"location":"state-db"}', 1);
      `);
    } finally {
      database.close();
    }
    expect(prepareSharedAuthStoreOwnershipForNative(fixture.env)).toEqual({
      location: "state-db",
    });
  });

  it.runIf(process.platform === "linux")(
    "preserves the live auth source's POSIX locks during copied inspection",
    async () => {
      const fixture = await createEmptyFixture(false);
      stateDb.openOpenClawStateDatabase({ env: fixture.env });
      fs.mkdirSync(path.dirname(fixture.sourcePath), { recursive: true });
      const writer = new DatabaseSync(fixture.sourcePath);
      try {
        writer.exec(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE auth_profile_store (store_key TEXT, store_json TEXT, updated_at INTEGER);
          INSERT INTO auth_profile_store VALUES ('primary', '{"version":1,"profiles":{}}', 1);
        `);
        const before = readMainDatabasePosixLocks(fixture.sourcePath);
        expect(before).toEqual([
          { length: 510, pid: process.pid, start: 1073741826, type: "read" },
        ]);
        expect(fixture.detect({ env: fixture.env, artifactPreservingReadOnly: true })).toEqual({
          sourcePath: fixture.sourcePath,
          hasLegacy: true,
        });
        expect(readMainDatabasePosixLocks(fixture.sourcePath)).toEqual(before);
        expect(rows(writer, "SELECT store_key FROM auth_profile_store")).toEqual([
          { store_key: "primary" },
        ]);
      } finally {
        writer.close();
      }
    },
  );

  it.each([
    { label: "fresh profile", createSourceDatabase: false },
    { label: "legacy profile with an empty source database", createSourceDatabase: true },
  ])("records ownership without reporting relocation for a $label", async (testCase) => {
    const fixture = await createEmptyFixture(testCase.createSourceDatabase);
    expect(fs.existsSync(fixture.sourcePath)).toBe(testCase.createSourceDatabase);

    const detected = fixture.detect();
    expect(detected.hasLegacy).toBe(true);
    expect(await fixture.migrate(detected)).toEqual({ changes: [], warnings: [] });
    expect(ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
      location: "state-db",
    });
  });

  it("moves exact rows, preserves every effective agent store, and records receipts", async () => {
    const fixture = await createFixture();
    const effectiveBytes = (agentDir: string) => {
      const effective = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
      return JSON.stringify({
        credentials: persisted.buildPersistedAuthProfileSecretsStore(effective),
        state: authState.buildPersistedAuthProfileState(effective),
      });
    };
    const before = {
      main: effectiveBytes(fixture.mainAgentDir),
      ops: effectiveBytes(fixture.opsAgentDir),
    };
    const detected = fixture.detect();

    const migrate = () => fixture.migrate(detected);
    expect(await migrate()).toMatchObject({
      warnings: [],
      changes: [expect.stringContaining("Relocated shared auth")],
    });

    expect({
      store: sqlite.readPersistedAuthProfileStoreRaw(),
      state: sqlite.readPersistedAuthProfileStateRaw(),
      local: localAuth(fixture.mainAgentDir),
    }).toEqual({
      store: fixture.sharedStore,
      state: fixture.sharedState,
      local: { store: null, state: null },
    });
    expect({
      main: effectiveBytes(fixture.mainAgentDir),
      ops: effectiveBytes(fixture.opsAgentDir),
    }).toEqual(before);

    const database = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
    expect(machineRow(database, "authProfiles.store")).toEqual({
      value_json: JSON.stringify(fixture.sharedStore),
    });
    expect(machineRow(database, "authProfiles.state")).toEqual({
      value_json: JSON.stringify(fixture.sharedState),
    });
    expect(
      row(
        database,
        "SELECT COUNT(*) AS count FROM migration_sources WHERE migration_kind = ?",
        "shared-auth-store-state-db",
      ),
    ).toEqual({ count: 2 });
    expect(machineRow(database, "auth.sharedStore")).toEqual({
      value_json: JSON.stringify({ location: "state-db" }),
    });
  });

  it.each(["order state", "credential override"] as const)(
    "preserves post-relocation main-agent %s without treating it as legacy",
    async (scenario) => {
      const fixture = await createEmptyFixture(false);
      const mainAgentDir = path.dirname(fixture.sourcePath);
      const profileId = "openai:shared";
      await upsertAuthProfileWithLockOrThrow({
        profileId,
        stateDir: fixture.stateDir,
        credential:
          scenario === "order state"
            ? {
                type: "api_key",
                provider: "openai",
                keyRef: { source: "env", provider: "default", id: "OPENCLAW_SHARED_AUTH_TEST_KEY" },
              }
            : { type: "api_key", provider: "openai", key: "shared-key" },
      });
      if (scenario === "order state") {
        await setAuthProfileOrder({
          agentDir: mainAgentDir,
          provider: "openai",
          order: [profileId],
        });
        expect(localAuth(mainAgentDir)).toEqual({
          store: { version: 1, profiles: {} },
          state: { version: 1, order: { openai: [profileId] } },
        });
      } else {
        saveAuthProfileStore(makeStore(profileId, "local-override-key"), mainAgentDir, {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        });
        expect(localAuth(mainAgentDir).store).toEqual(makeStore(profileId, "local-override-key"));
        expect(sharedAuth(fixture.env).store).toEqual(makeStore(profileId, "shared-key"));
      }
      const localBefore = localAuth(mainAgentDir);
      const sharedBefore = sharedAuth(fixture.env);
      const detected = fixture.detect({ env: fixture.env });
      expect(detected).toEqual({ sourcePath: fixture.sourcePath, hasLegacy: false });
      expect(await fixture.migrate(detected, fixture.env)).toEqual({ changes: [], warnings: [] });
      expect({ local: localAuth(mainAgentDir), shared: sharedAuth(fixture.env) }).toEqual({
        local: localBefore,
        shared: sharedBefore,
      });
    },
  );

  it.each([
    "older subset",
    "empty subset",
    "changed credential",
    "source-only profile",
    "malformed source",
    "malformed target",
    "malformed target profile",
    "changed metadata",
    "changed state",
  ])("verifies a richer target against a %s before cleanup", async (scenario) => {
    const fixture = await createFixture();
    const sourcePath = sqlite.resolveAuthProfileDatabasePath(fixture.mainAgentDir);
    const source = new DatabaseSync(sourcePath);
    try {
      const target = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
      const sourceStore =
        scenario === "empty subset" ? { version: 1, profiles: {} } : fixture.sharedStore;
      const escapedProfileId = 'a"\nprofile';
      if (scenario === "changed credential") {
        Object.assign(sourceStore.profiles, makeStore(escapedProfileId, "shared-key").profiles);
      }
      const sourceJson =
        scenario === "malformed source"
          ? '{"version":1,"profiles":{"bad":null}}'
          : JSON.stringify(sourceStore);
      source
        .prepare(
          "UPDATE auth_profile_store SET store_json = ?, updated_at = 100 WHERE store_key = 'primary'",
        )
        .run(sourceJson);
      const sourceRow = readSourceRow(source, "store");
      const stateRow = readSourceRow(source, "state") as { state_json: string; updated_at: number };
      const targetStore = {
        profiles: {
          ...makeStore("openai:extra", "extra-key").profiles,
          ...(scenario === "malformed target profile" ? { bad: null } : {}),
          ...(scenario === "source-only profile"
            ? {}
            : makeStore(
                "openai:shared",
                scenario === "changed credential" ? "different-key" : "shared-key",
              ).profiles),
        },
        version: 1,
        ...(scenario === "changed metadata" ? { legacyMetadata: "keep" } : {}),
      };
      const targetRow = {
        value_json:
          scenario === "malformed target"
            ? '{"version":1,"profiles":null}'
            : JSON.stringify(targetStore),
        updated_at_ms: 200,
      };
      target
        .prepare("INSERT INTO config_machine_state VALUES ('authProfiles.store', ?, ?)")
        .run(targetRow.value_json, targetRow.updated_at_ms);
      target
        .prepare("INSERT INTO config_machine_state VALUES ('authProfiles.state', ?, ?)")
        .run(
          stateRow.state_json,
          stateRow.updated_at + Number(["changed state", "changed credential"].includes(scenario)),
        );

      const detected = fixture.detect();
      const result = await fixture.migrate(detected);
      const migratedTarget = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
      const converges = scenario.endsWith("subset");
      expect(result.warnings).toEqual(
        converges ? [] : [expect.stringMatching(/conflict.*Back up/)],
      );
      const conflictDetails: Record<string, string> = {
        "changed credential": '"openai:shared": credential differs',
        "source-only profile": '"openai:shared": missing from target',
        "malformed source": '"bad": malformed credential',
        "malformed target": "invalid credential payload",
        "malformed target profile": '"bad": malformed credential',
        "changed metadata": "store metadata differs",
        "changed state": "auth_profile_state[primary] -> config_machine_state[authProfiles.state]",
      };
      if (!converges) {
        expect(result.warnings[0]).toContain(conflictDetails[scenario]);
        expect(result.warnings[0]).toContain("openclaw doctor --fix");
        expect(result.warnings[0]).toContain(JSON.stringify(sourcePath));
        expect(result.warnings[0]).toContain(
          JSON.stringify(path.join(fixture.stateDir, "state", "openclaw.sqlite")),
        );
        expect(result.warnings[0]).not.toMatch(/shared-key|extra-key|different-key|legacyMetadata/);
      }
      expect(machineRow(migratedTarget, "authProfiles.store", true)).toEqual(targetRow);
      expect(readSourceRow(source, "store")).toEqual(converges ? undefined : sourceRow);
      expect(readSourceRow(source, "state")).toEqual(converges ? undefined : stateRow);
      const receipt = receiptRow(migratedTarget);
      expect(receipt).toEqual(
        converges
          ? {
              source_sha256: createHash("sha256").update(JSON.stringify(sourceRow)).digest("hex"),
              source_record_count: 1,
              status: "completed",
              removed_source: 1,
            }
          : undefined,
      );
      expect(fixture.detect().hasLegacy).toBe(!converges);
      if (scenario === "changed credential") {
        const warning = result.warnings[0]!;
        expect(warning).toContain(`${JSON.stringify(escapedProfileId)}: missing from target`);
        expect(warning.indexOf(JSON.stringify(escapedProfileId))).toBeLessThan(
          warning.indexOf('"openai:shared"'),
        );
        expect(warning).toContain(conflictDetails["changed state"]);
        expect(warning).not.toContain("\n");
        // Follow the diagnostic: retain target-only profiles and reconcile both conflicting rows.
        migratedTarget
          .prepare(
            "UPDATE config_machine_state SET value_json = ? WHERE state_key = 'authProfiles.store'",
          )
          .run(
            JSON.stringify({
              ...targetStore,
              profiles: { ...targetStore.profiles, ...sourceStore.profiles },
            }),
          );
        migratedTarget
          .prepare(
            "UPDATE config_machine_state SET updated_at_ms = ? WHERE state_key = 'authProfiles.state'",
          )
          .run(stateRow.updated_at);
        expect(await fixture.migrate(detected)).toMatchObject({
          warnings: [],
          changes: [expect.stringContaining("Relocated shared auth")],
        });
        expect(sqlite.readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual({
          ...targetStore,
          profiles: { ...targetStore.profiles, ...sourceStore.profiles },
        });
        expect(fixture.detect().hasLegacy).toBe(false);
      }
    } finally {
      source.close();
    }
  });

  it.each(["absolute", "tilde"] as const)(
    "detects and relocates only the selected env's %s shared auth source",
    (pathStyle) =>
      (ownerFixtureRun = (async () => {
        const createOwner = async () => {
          const owner = await createOpenClawTestState({
            prefix: "openclaw-shared-auth-source-owner-",
            layout: "split",
            applyEnv: false,
            env: {
              OPENCLAW_AGENT_DIR: undefined,
              PI_CODING_AGENT_DIR: undefined,
              OPENCLAW_OAUTH_DIR: undefined,
              // These auth owners have no plugin inventory; keep discovery inside the fixture.
              OPENCLAW_BUNDLED_PLUGINS_DIR: tempDirs.make("openclaw-shared-auth-bundled-"),
            },
          });
          ownerStates.push(owner);
          return owner;
        };
        const selected = await createOwner();
        const ambient = await createOwner();
        const selectedDir = path.join(selected.home, "relocated-auth");
        const ambientDir = path.join(ambient.home, "relocated-auth");
        const selectedEnv = {
          ...selected.env,
          OPENCLAW_AGENT_DIR: pathStyle === "tilde" ? "~/relocated-auth" : selectedDir,
        };
        const ambientEnv = {
          ...ambient.env,
          OPENCLAW_AGENT_DIR: pathStyle === "tilde" ? "~/relocated-auth" : ambientDir,
        };
        ambient.applyEnv();
        vi.stubEnv("OPENCLAW_AGENT_DIR", ambientEnv.OPENCLAW_AGENT_DIR);
        const profileId = "openai:source";
        const selectedStore = makeStore(profileId, `fake-selected-${randomUUID()}`);
        const ambientStore = makeStore(profileId, `fake-ambient-${randomUUID()}`);
        const selectedState = { version: 1, usageStats: { [profileId]: { lastUsed: 20 } } };
        const ambientState = { version: 1, usageStats: { [profileId]: { lastUsed: 10 } } };
        for (const source of [
          { agentDir: selectedDir, env: selectedEnv, store: selectedStore, state: selectedState },
          { agentDir: ambientDir, env: ambientEnv, store: ambientStore, state: ambientState },
        ]) {
          sqlite.runAuthProfileWriteTransaction(
            source.agentDir,
            (database) => {
              sqlite.writePersistedAuthProfileStoreRaw(source.store, source.agentDir, database);
              sqlite.writePersistedAuthProfileStateRaw(source.state, source.agentDir, database);
            },
            { env: source.env },
          );
          expect(sqlite.readPersistedAuthProfileStoreRaw(source.agentDir)).toEqual(source.store);
          expect(sqlite.readPersistedAuthProfileStateRaw(source.agentDir)).toEqual(source.state);
        }

        const detected = await doctor.detectLegacyStateMigrations({
          cfg: { plugins: { enabled: false } },
          env: selectedEnv,
          homedir: () => selected.home,
          doctorOnlyStateMigrations: true,
          pluginSessionStoreAgentIds: [],
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        expect(detected.stateDir).toBe(selected.stateDir);
        expect(detected.stateSchema.hasLegacy).toBe(false);
        const selectedSourcePath = sqlite.resolveAuthProfileDatabasePath(selectedDir);
        expect.soft(detected.sharedAuthStore).toEqual({
          sourcePath: selectedSourcePath,
          hasLegacy: true,
        });
        const result = await migration.migrateSharedAuthStore({
          detected: detected.sharedAuthStore,
          stateDir: detected.stateDir,
          env: selectedEnv,
        });

        expect.soft(result.warnings).toEqual([]);
        expect
          .soft({
            shared: sharedAuth(selectedEnv),
            selected: localAuth(selectedDir),
            ambient: localAuth(ambientDir),
          })
          .toEqual({
            shared: { store: selectedStore, state: selectedState },
            selected: { store: null, state: null },
            ambient: { store: ambientStore, state: ambientState },
          });
        const receipts = rows(
          stateDb.openOpenClawStateDatabase({ env: selectedEnv }).db,
          "SELECT source_path, status, removed_source FROM migration_sources",
        );
        expect.soft(receipts).toHaveLength(2);
        for (const receipt of receipts) {
          expect.soft(receipt).toEqual({
            source_path: selectedSourcePath,
            status: "completed",
            removed_source: 1,
          });
        }
      })()),
  );

  it("defers shared auth inspection while the selected state schema needs repair", async () => {
    const fixture = await createEmptyFixture(false);
    const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    const legacyDatabase = new DatabaseSync(stateDatabasePath);
    try {
      legacyDatabase.exec(`
        PRAGMA user_version = 8;
        CREATE TABLE agent_databases (
          agent_id TEXT NOT NULL,
          path TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          size_bytes INTEGER,
          PRIMARY KEY (agent_id, path)
        );
        INSERT INTO agent_databases VALUES ('main', 'agent.sqlite', 1, 10, 20);
      `);
    } finally {
      legacyDatabase.close();
    }
    const stateBytes = fs.readFileSync(stateDatabasePath);
    const sourceBytes = "not a SQLite database";
    fs.mkdirSync(path.dirname(fixture.sourcePath), { recursive: true });
    fs.writeFileSync(fixture.sourcePath, sourceBytes);
    const ambientStateDir = tempDirs.make("openclaw-shared-auth-pending-ambient-");
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientStateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", path.join(ambientStateDir, "relocated-auth"));

    const detected = await doctor.detectLegacyStateMigrations({
      cfg: { plugins: { enabled: false } },
      env: fixture.env,
      doctorOnlyStateMigrations: true,
      pluginSessionStoreAgentIds: [],
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(detected.stateDir).toBe(fixture.stateDir);
    expect(detected.stateSchema.hasLegacy).toBe(true);
    expect(detected.sharedAuthStore).toEqual({ sourcePath: fixture.sourcePath, hasLegacy: false });
    expect(fs.readFileSync(fixture.sourcePath, "utf8")).toBe(sourceBytes);
    expect(fs.readFileSync(stateDatabasePath)).toEqual(stateBytes);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
  });

  for (const crashState of [
    "copied-not-flipped",
    "copied-source-empty-not-flipped",
    "flipped-not-cleaned",
    "flipped-cleaned-not-finalized",
  ] as const) {
    it(`converges after the ${crashState} stage boundary`, async () => {
      const fixture = await createFixture();
      const sourcePath = sqlite.resolveAuthProfileDatabasePath(fixture.mainAgentDir);
      const source = new DatabaseSync(sourcePath);
      const sourceStore = readSourceRow(source, "store") as {
        store_json: string;
        updated_at: number;
      };
      const sourceState = readSourceRow(source, "state") as {
        state_json: string;
        updated_at: number;
      };
      const target = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
      const targetStoreJson =
        crashState === "flipped-cleaned-not-finalized"
          ? JSON.stringify({
              ...fixture.sharedStore,
              profiles: {
                ...fixture.sharedStore.profiles,
                ...makeStore("openai:extra", "extra-key").profiles,
              },
            })
          : sourceStore.store_json;
      target
        .prepare("INSERT INTO config_machine_state VALUES ('authProfiles.store', ?, ?)")
        .run(targetStoreJson, sourceStore.updated_at);
      target
        .prepare("INSERT INTO config_machine_state VALUES ('authProfiles.state', ?, ?)")
        .run(sourceState.state_json, sourceState.updated_at);
      if (
        crashState === "copied-source-empty-not-flipped" ||
        crashState === "flipped-cleaned-not-finalized"
      ) {
        source.prepare("DELETE FROM auth_profile_store WHERE store_key = 'primary'").run();
        source.prepare("DELETE FROM auth_profile_state WHERE state_key = 'primary'").run();
      }
      source.close();
      if (crashState === "flipped-not-cleaned" || crashState === "flipped-cleaned-not-finalized") {
        target
          .prepare(`INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
             VALUES ('auth.sharedStore', ?, 1)`)
          .run(JSON.stringify({ location: "state-db" }));
        ownership.noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, fixture.env);
        const runId = "test-shared-auth-pending-cleanup";
        const sourceKey = `shared-auth-store:${createHash("sha256")
          .update(path.resolve(sourcePath))
          .update("\0")
          .update("auth_profile_store")
          .digest("hex")}`;
        target
          .prepare(`INSERT INTO migration_runs (id, started_at, finished_at, status, report_json)
             VALUES (?, 1, NULL, 'ownership-flipped', '{}')`)
          .run(runId);
        target
          .prepare(`INSERT INTO migration_sources
               (source_key, migration_kind, source_path, target_table, source_sha256,
                source_size_bytes, source_record_count, last_run_id, status, imported_at,
                removed_source, report_json)
             VALUES (?, 'shared-auth-store-state-db', ?, 'auth_profile_stores', ?,
                     NULL, 1, ?, 'ownership-flipped', 1, 0, '{}')`)
          .run(
            sourceKey,
            sourcePath,
            createHash("sha256").update(JSON.stringify(sourceStore)).digest("hex"),
            runId,
          );
      }

      const detected = fixture.detect();
      const first = await fixture.migrate(detected);
      const retryDetected = fixture.detect();
      const retry = await fixture.migrate(retryDetected);
      const migratedTarget = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;

      expect(first.warnings).toEqual([]);
      expect(retryDetected).toMatchObject({ hasLegacy: false });
      expect(ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
        location: "state-db",
      });
      expect(retry).toEqual({ changes: [], warnings: [] });
      if (crashState === "flipped-cleaned-not-finalized") {
        expect(receiptRow(migratedTarget)).toEqual({
          source_sha256: createHash("sha256").update(JSON.stringify(sourceStore)).digest("hex"),
          source_record_count: 1,
          status: "completed",
          removed_source: 1,
        });
        expect(machineRow(migratedTarget, "authProfiles.store")).toEqual({
          value_json: targetStoreJson,
        });
      }
      expect(count(migratedTarget, "config_machine_state", "state_key", "authProfiles.store")).toBe(
        1,
      );
      expect(count(migratedTarget, "config_machine_state", "state_key", "authProfiles.state")).toBe(
        1,
      );
      const cleanedSource = new DatabaseSync(sourcePath, { readOnly: true });
      expect(count(cleanedSource, "auth_profile_store", "store_key", "primary")).toBe(0);
      expect(count(cleanedSource, "auth_profile_state", "state_key", "primary")).toBe(0);
      cleanedSource.close();
    });
  }

  it.each(["dangling symlink", "unreadable file"] as const)(
    "fails closed for a legacy source with a %s",
    async (scenario) => {
      const fixture = await createFixture();
      const sourcePath = fixture.sourcePath;
      if (scenario === "dangling symlink") {
        closeOpenClawAgentDatabasesForTest();
        fs.unlinkSync(sourcePath);
        fs.symlinkSync(`${sourcePath}.missing`, sourcePath);
      } else {
        const realLstat = fs.lstatSync;
        vi.spyOn(fs, "lstatSync").mockImplementation((pathname, options) => {
          if (path.resolve(String(pathname)) === path.resolve(sourcePath)) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return realLstat(pathname, options as never);
        });
        expect(fixture.detect({ doctorOnlyStateMigrations: false })).toEqual({
          sourcePath,
          hasLegacy: false,
        });
      }
      expect(() => fixture.detect()).toThrowError(
        expect.objectContaining({
          name: "SharedAuthStoreSourceInspectionError",
          code: "SHARED_AUTH_STORE_SOURCE_UNREADABLE",
          sourcePath,
          ...(scenario === "dangling symlink" ? { action: "openclaw doctor --fix" } : {}),
        }),
      );
      expect(
        machineRow(stateDb.openOpenClawStateDatabase({ env: fixture.env }).db, "auth.sharedStore"),
      ).toBeUndefined();
    },
  );
});
