import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqlite from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import * as writerQueue from "../../shared/store-writer-queue.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { resolveStateDir } from "../paths.js";
import {
  loadSessionEntry,
  onSessionIdentityMutation,
  patchSessionEntryCore,
  createSessionEntryWithTranscript,
} from "./session-accessor.js";
import {
  patchSessionEntryTarget,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { createWorkerSqliteIntegrityGate } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";

const roots = createTempDirTracker();
const worker = vi.hoisted(() => ({
  gate: undefined as ReturnType<typeof createWorkerSqliteIntegrityGate> | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { observeWorkerSqliteIntegrity } =
    await import("./session-accessor.sqlite-integrity-counter.test-support.js");
  return {
    ...actual,
    Worker: observeWorkerSqliteIntegrity(actual.Worker, () => worker.gate),
  };
});
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const realOpen = sqlite.openNodeSqliteDatabase;
let queued = vi.spyOn(writerQueue, "runQueuedStoreWrite");

beforeEach(() => {
  resetConfigRuntimeState();
  setRuntimeConfigSnapshot({}, {});
  queued = vi.spyOn(writerQueue, "runQueuedStoreWrite");
});

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await Promise.allSettled(pending.splice(0));
  // Join the actual default-budget kicks too; this suite does not disable retention.
  let joined = -1;
  while (joined !== queued.mock.results.length) {
    joined = queued.mock.results.length;
    await Promise.allSettled(
      queued.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  memorySessionActorOwners.reset();
  if (worker.gate) {
    expect([...worker.gate.workers].every((observed) => observed.threadId === -1)).toBe(true);
    worker.gate = undefined;
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  roots.cleanup();
});

function own<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

function cachedDatabase(databasePath: string) {
  return getOpenClawAgentDatabaseIfOpen({ agentId: "main", path: databasePath });
}

function stateRoot(label = "session-patch-admission-") {
  const root = roots.make(label);
  const env = { OPENCLAW_STATE_DIR: root };
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  return { root, env };
}

function patch(
  scope: Parameters<typeof patchSessionEntryCore>[0],
  update: Parameters<typeof patchSessionEntryCore>[1],
  options: Parameters<typeof patchSessionEntryCore>[2] = {},
) {
  return own(patchSessionEntryCore(scope, update, { skipMaintenance: true, ...options }));
}

function fixture(sessionKey = "agent:main:admission") {
  const { root, env } = stateRoot();
  const scope = { agentId: "main", env, sessionKey };
  replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  return { root, env, scope, database, databasePath: database.path };
}

async function memoryFixture() {
  const { root, env } = stateRoot("session-memory-patch-admission-");
  const scope = { agentId: "main", env, sessionKey: "agent:main:dashboard:incognito-admission" };
  await createSessionEntryWithTranscript(scope, () => ({
    ok: true,
    entry: { sessionId: "original", updatedAt: 1, incognito: true },
  }));
  return { root, env, scope };
}

function evictHandle(databasePath: string) {
  const database = cachedDatabase(databasePath);
  if (!database) {
    throw new Error("Fixture lost its cached handle before eviction");
  }
  closeCachedOpenClawAgentDatabase(database);
  expect(database.db.isOpen).toBe(false);
}

function closeCold(f: ReturnType<typeof fixture>) {
  evictHandle(f.databasePath);
  invalidateOpenClawAgentDatabaseValidation(f.databasePath);
  revokeSqliteDatabaseAdmissionsForPath(f.databasePath);
}

function nativeChecks(databasePath: string) {
  let parentChecks = 0;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const database = realOpen(pathname, options);
    if (pathname !== databasePath || options?.readOnly) {
      return database;
    }
    const prepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === "PRAGMA integrity_check;" || sql === "PRAGMA integrity_check('sqlite_schema');") {
        const all = statement.all.bind(statement);
        statement.all = () => {
          parentChecks += 1;
          return all();
        };
      }
      return statement;
    };
    return database;
  });
  return () => parentChecks;
}

function holdWorkerValidation(databasePath: string) {
  const gate = createWorkerSqliteIntegrityGate(databasePath);
  worker.gate = gate;
  gate.arm();
  releases.push(gate.release);
  return gate;
}

function expectAdmission(
  gate: ReturnType<typeof holdWorkerValidation>,
  operation: Promise<unknown>,
) {
  return awaitGateBeforeSettlement(
    gate.entered,
    operation,
    "cold patch settled before a pending native admission could be observed",
  );
}

it.each(["sessions.json", "custom.json"])(
  "keeps concurrent first writes in one custom store (%s)",
  async (filename) => {
    const { root, env } = stateRoot("session-patch-first-writes-");
    const storePath = path.join(root, "custom-store", filename);
    const entries = ["first", "second", "third"].map((name) => ({
      sessionKey: `agent:main:${name}`,
      entry: { sessionId: `session-${name}`, updatedAt: Date.now() },
    }));
    await Promise.all(
      entries.map(({ sessionKey, entry }) =>
        own(replaceSessionEntry({ env, storePath, sessionKey }, entry)),
      ),
    );
    expect(
      entries.map(({ sessionKey }) => loadSessionEntry({ env, storePath, sessionKey })?.sessionId),
    ).toEqual(entries.map(({ entry }) => entry.sessionId));
    expect(
      fs.readdirSync(path.dirname(storePath)).filter((entryName) => entryName.endsWith(".sqlite")),
    ).toHaveLength(1);
  },
);

it.each([
  ["target", "preparation"],
  ["entry", "commit"],
] as const)("keeps %s %s integrity checks off the caller thread", async (kind, phase) => {
  const f = fixture();
  if (phase === "preparation") {
    closeCold(f);
  }
  const parentChecks = nativeChecks(f.databasePath);
  const update = () => {
    if (phase === "commit") {
      closeCold(f);
    }
    return { label: "updated" };
  };
  const operation = own(
    kind === "entry"
      ? patch(f.scope, update)
      : patchSessionEntryTarget(
          {
            agentId: "main",
            storePath: f.databasePath,
            target: { canonicalKey: f.scope.sessionKey, storeKeys: [f.scope.sessionKey] },
          },
          update,
          { skipMaintenance: true },
        ),
  );
  const expected = { sessionId: "original", label: "updated" };
  await expect(operation).resolves.toMatchObject(expected);
  expect(loadSessionEntry(f.scope)).toMatchObject(expected);
  expect(parentChecks()).toBe(0);
});

it.each(["worker", "legacy callback", "incognito"] as const)(
  "admits %s updater invocation through its owner",
  async (mode) => {
    const f = mode === "incognito" ? await memoryFixture() : fixture();
    const native = vi.spyOn(integrity, "assertSqliteIntegrityInWorker");
    const update = vi.fn(() => ({ label: mode }));
    const operation = patch(f.scope, update, {
      assertCommitAllowed: mode === "legacy callback" ? () => {} : undefined,
    });
    await expect(operation).resolves.toMatchObject({ label: mode });
    expect(update).toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    if (mode === "incognito") {
      expect(fs.readdirSync(f.root)).toEqual([]);
    }
  },
);

it("returns an accepted unchanged patch receipt without publishing a new source", async () => {
  const f = fixture();
  const options = { skipMaintenance: true, preserveActivity: true };
  await patchSessionEntryCore(f.scope, () => ({}), options);
  const onCommitted = vi.fn();
  const onCommittedSource = vi.fn();
  const committed = await patchSessionEntryCore(f.scope, () => ({}), {
    ...options,
    onCommitted,
    onCommittedSource,
  });
  expect(committed).toMatchObject({ sessionId: "original", updatedAt: 1 });
  expect(onCommitted).toHaveBeenCalledExactlyOnceWith(committed);
  expect(onCommittedSource).not.toHaveBeenCalled();
  expect(loadSessionEntry(f.scope)).toEqual(committed);
});

it("captures the queued ambient state owner before admission", async () => {
  const f = fixture();
  const original = { ...f.scope, env: { ...f.env } };
  const successor = roots.make("session-patch-successor-");
  const release = createDeferred();
  releases.push(() => release.resolve());
  const blocker = own(
    runExclusiveSqliteSessionWrite(
      resolveSqliteScope(original),
      () => release.promise,
      "session.transcript.batch",
    ),
  );
  const scope = { agentId: "main", sessionKey: original.sessionKey };
  const operation = patch(scope, () => {
    expect(cachedDatabase(f.databasePath)).toBeUndefined();
    return { label: "original owner" };
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", successor);
  evictHandle(f.databasePath);
  release.resolve();
  await blocker;
  await expect(operation).resolves.toMatchObject({
    sessionId: "original",
    label: "original owner",
  });
  expect(loadSessionEntry(original)).toMatchObject({ label: "original owner" });
  expect(fs.readdirSync(successor)).toEqual([]);
});

it("keeps the physical database owner for logical rows in a shared store", async () => {
  const f = fixture();
  const storePath = path.join(f.root, "shared.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", env: f.env, path: storePath });
  const main = { ...f.scope, storePath, sessionKey: "agent:main:kept" };
  const secondary = { ...main, agentId: "secondary", sessionKey: "agent:secondary:shared" };
  replaceSessionEntrySync(main, { sessionId: "kept", updatedAt: 1 });
  replaceSessionEntrySync(secondary, { sessionId: "secondary", updatedAt: 1 });
  evictHandle(storePath);
  await expect(
    patch(secondary, () => {
      expect(cachedDatabase(storePath)).toBeUndefined();
      return { label: "shared owner" };
    }),
  ).resolves.toMatchObject({ sessionId: "secondary", label: "shared owner" });
  expect(loadSessionEntry(main)).toMatchObject({ sessionId: "kept" });
  expect(
    openOpenClawAgentDatabase({ agentId: "main", env: f.env, path: storePath })
      .db.prepare("SELECT agent_id FROM schema_meta")
      .get(),
  ).toMatchObject({ agent_id: "main" });
  expect(
    fs.existsSync(path.join(f.root, "agents", "secondary", "agent", "openclaw-agent.sqlite")),
  ).toBe(false);
});

it("retains FIFO, caller context and publication across cold admission", async () => {
  const f = fixture();
  closeOpenClawAgentDatabaseByPath(f.databasePath);
  invalidateOpenClawAgentDatabaseValidation(f.databasePath);
  revokeSqliteDatabaseAdmissionsForPath(f.databasePath);
  const gate = holdWorkerValidation(f.databasePath);
  const contexts = new AsyncLocalStorage<string>();
  const order: string[] = [];
  const updateRelease = createDeferred();
  releases.push(() => updateRelease.resolve());
  const enteredUpdater = createDeferred();
  let holdUpdater = false;
  const unsubscribe = onSessionIdentityMutation((mutation) => {
    if (mutation.kind !== "delete" && mutation.current.sessionKeys.includes(f.scope.sessionKey)) {
      order.push(`published:${mutation.current.sessionId}`);
    }
  });
  releases.push(unsubscribe);
  const first = contexts.run("first", () =>
    patch(
      f.scope,
      async () => {
        order.push(`update:${contexts.getStore()}`);
        enteredUpdater.resolve();
        if (holdUpdater) {
          await updateRelease.promise;
        }
        return { sessionId: "first" };
      },
      { onCommitted: () => order.push(`commit:${contexts.getStore()}`) },
    ),
  );
  await expectAdmission(gate, first);
  holdUpdater = true;
  const second = contexts.run("second", () =>
    patch(
      f.scope,
      (entry) => {
        order.push(`update:${contexts.getStore()}:${entry.sessionId}`);
        return { sessionId: "second" };
      },
      { onCommitted: () => order.push(`commit:${contexts.getStore()}`) },
    ),
  );
  expect(order).toEqual([]);
  gate.release();
  await enteredUpdater.promise;
  expect(order).toEqual(["update:first"]);
  updateRelease.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual([
    "update:first",
    "commit:first",
    "published:first",
    "update:second:first",
    "commit:second",
    "published:second",
  ]);
  expect(loadSessionEntry(f.scope)?.sessionId).toBe("second");
});

it.each(["dispose", "physical replacement"] as const)(
  "rejects %s before updater admission and recovers the lane",
  async (mode) => {
    const f = fixture();
    closeCold(f);
    const gate = holdWorkerValidation(f.databasePath);
    const update = vi.fn(() => ({ label: "must not commit" }));
    const committed = vi.fn();
    const operation = patch(f.scope, update, { onCommitted: committed });
    await expectAdmission(gate, operation);
    expect(update).not.toHaveBeenCalled();
    if (mode === "dispose") {
      closeOpenClawAgentDatabaseByPath(f.databasePath);
    } else {
      const replacementPath = `${f.databasePath}.replacement`;
      fs.copyFileSync(f.databasePath, replacementPath);
      fs.renameSync(replacementPath, f.databasePath);
    }
    gate.release();
    await expect(operation).rejects.toThrow(/closed|revoked|replaced|changed/);
    expect(update).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
    expect(loadSessionEntry(f.scope)).not.toHaveProperty("label");
    await expect(patch(f.scope, () => ({ label: "successor" }))).resolves.toMatchObject({
      label: "successor",
    });
  },
);

it.each(["cancel", "revoke"] as const)(
  "rechecks %s authority after cold commit admission",
  async (mode) => {
    const f = fixture();
    const gate = holdWorkerValidation(f.databasePath);
    let allowed = true;
    const revoked = new Error("authority revoked during commit admission");
    const committed = vi.fn();
    const operation = patch(
      f.scope,
      () => {
        closeCold(f);
        return { sessionId: "uncommitted" };
      },
      {
        shouldCommit: () => mode !== "cancel" || allowed,
        assertCommitAllowed: () => {
          if (!allowed && mode === "revoke") {
            throw revoked;
          }
        },
        onCommitted: committed,
      },
    );
    await expectAdmission(gate, operation);
    allowed = false;
    gate.release();
    if (mode === "cancel") {
      await expect(operation).resolves.toBeNull();
    } else {
      await expect(operation).rejects.toBe(revoked);
    }
    expect(committed).not.toHaveBeenCalled();
    expect(loadSessionEntry(f.scope)?.sessionId).toBe("original");
    expect(cachedDatabase(f.databasePath)?.db.isTransaction).toBe(false);
  },
);

it("pins the selected root for relative native reopen patch work", async () => {
  const home = roots.make("session-patch-root-selection-");
  const ownerRoot = path.join(home, "state");
  const successor = path.join(home, "next-cwd");
  fs.mkdirSync(ownerRoot);
  fs.mkdirSync(successor);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_CONFIG_PATH: path.join(ownerRoot, "openclaw.json"),
    OPENCLAW_STATE_DIR: "state",
  };
  vi.stubEnv("OPENCLAW_STATE_DIR", ownerRoot);
  const scope = { agentId: "main", env, sessionKey: "agent:main:root-selection" };
  const original = { ...scope, env: { ...env, OPENCLAW_STATE_DIR: ownerRoot } };
  expect(resolveStateDir(env)).toBe(ownerRoot);
  replaceSessionEntrySync(original, { sessionId: "original", updatedAt: 1 });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(original)));
  const selectedPath = database.path;
  const updaterEntered = createDeferred();
  const operation = patch(
    scope,
    () => {
      evictHandle(selectedPath);
      cwd.mockReturnValue(successor);
      updaterEntered.resolve();
      return { label: "retained selected root" };
    },
    {
      assertCommitAllowed: () => {},
    },
  );
  await awaitGateBeforeSettlement(
    updaterEntered.promise,
    operation,
    "Patch settled before its root-selection updater",
  );
  // Unchanged caller inputs now resolve elsewhere; admission must retain its selected root.
  expect(resolveStateDir(env)).toBe(path.join(successor, "state"));
  const expected = { sessionId: "original", label: "retained selected root" };
  await expect(operation).resolves.toMatchObject(expected);
  expect(loadSessionEntry(original)).toMatchObject(expected);
  expect(env.OPENCLAW_STATE_DIR).toBe("state");
  expect(fs.readdirSync(successor, { recursive: true })).toEqual([]);
});
