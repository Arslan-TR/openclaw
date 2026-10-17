import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction as writeTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  applySessionEntryReplacements,
  assignSessionOwner,
  listSessionParticipantsReadOnly,
  loadSessionEntry,
} from "./session-accessor.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  SessionEntryMaintenanceInput,
  SqliteSessionReclamationPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import * as candidates from "./session-accessor.sqlite-maintenance-candidates.js";
import {
  prepareSessionMaintenanceInWorker as prepareMaintenance,
  reclaimSessionMaintenanceInTransaction as reclaimMaintenance,
} from "./session-accessor.sqlite-maintenance-transaction.js";
import { applySessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { commitSessionEntryReplacementsInDatabase as commitReplacements } from "./session-accessor.sqlite-replacement-state.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import * as maintenanceRuntime from "./store-maintenance-runtime.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DAY_MS = 24 * 60 * 60 * 1000;
const key = (index: number) => `agent:main:cadence-${index}`;
const readEntry = (storePath: string, index = 0) =>
  loadSessionEntry({ storePath, sessionKey: key(index) });
const agePolicy = (overrides: Partial<ResolvedSessionMaintenanceConfig> = {}) => ({
  ...resolveMaintenanceConfigFromInput(),
  archiveDashboardAfterMs: null,
  preserveRecentMs: null,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

function createStore(entryCount: number, updatedAt = Date.now()) {
  const storePath = path.join(tempDirs.make("session-maintenance-cadence-"), "agent.sqlite");
  const options = { agentId: "main", path: storePath };
  const database = openOpenClawAgentDatabase(options);
  writeTransaction((owner) => {
    for (let index = 0; index < entryCount; index += 1) {
      writeFixtureEntry(owner, index, { updatedAt });
    }
  }, options);
  return { database, options, storePath };
}

function writeFixtureEntry(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  index: number,
  fields: Partial<SessionEntry> = {},
) {
  writeSessionEntry(database, key(index), {
    sessionId: `cadence-${index}`,
    updatedAt: Date.now(),
    ...fields,
  });
}

async function maintenanceInput(storePath: string) {
  const preservation = await prepareSessionMaintenancePreservation(storePath);
  onTestFinished(preservation.dispose);
  return {
    storePath,
    archiveDirectory: path.join(path.dirname(storePath), "archives"),
    maintenanceConfig: resolveMaintenanceConfigFromInput(),
    preservation: preservation.capture,
  };
}

async function createPlanningOperation(
  options: ReturnType<typeof createStore>["options"],
  input: Partial<SessionEntryMaintenanceInput> = {},
): Promise<Extract<SqliteSessionReclamationPlan, { kind: "maintenance-plan" }>> {
  const { maintenanceConfig: maintenance, ...defaults } = await maintenanceInput(options.path);
  return {
    kind: "maintenance-plan",
    databaseOptions: resolveSessionReclamationDatabaseOptions(options),
    materializedPlans: [],
    input: {
      ...defaults,
      maintenance,
      preservation: defaults.preservation(),
      ...input,
    },
  };
}

function renameEntry(storePath: string, index: number, label: string) {
  return replaceEntryInDatabase(storePath, index, (entry) => ({ ...entry, label }));
}

async function replaceEntryInDatabase(
  storePath: string,
  index: number,
  update: (entry: SessionEntry) => SessionEntry,
) {
  const preservation = await prepareSessionMaintenancePreservation(storePath);
  using _ = { [Symbol.dispose]: preservation.dispose };
  return writeTransaction(
    (database) => {
      const sessionKey = key(index);
      const row = readExactSessionEntryRow(database, sessionKey);
      if (!row) {
        throw new Error("Missing cadence fixture entry");
      }
      return commitReplacements(
        database,
        {
          expectedRows: new Map([[sessionKey, row]]),
          labelOwnerKeys: [],
          validationKeys: [sessionKey],
          replacements: [{ sessionKey, entry: update(row.entry) }],
          maintenance: {
            archiveDirectory: path.join(path.dirname(storePath), "archives"),
            maintenance: maintenanceRuntime.resolveMaintenanceConfig(),
            preservation: preservation.capture(),
            storePath,
          },
        },
        () => {},
      );
    },
    { agentId: "main", path: storePath },
  );
}

function writeMetadata(storePath: string, kind: "participant" | "owner", sequence: number) {
  const scope = { storePath, sessionKey: key(0) };
  return kind === "participant"
    ? recordSessionParticipant(scope, {
        identity: { type: "agent", id: "worker" },
        promptedAt: sequence,
        sessionAgentId: "main",
      })
    : assignSessionOwner(scope, {
        owner: { type: "agent", id: `worker-${sequence}` },
        assignedBy: { type: "agent", id: "main" },
        assignedAt: sequence,
      });
}

it.each(["participant", "owner"] as const)(
  "retains maintenance age facts across %s metadata writes",
  async (kind) => {
    const { database, storePath } = createStore(24);
    writeMetadata(storePath, kind, 0);
    const factReads = vi.spyOn(ageFacts, "recordSessionEntryMaintenanceAgeFact");
    const queries = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["after", "dashboards", "pending", "unexpected"],
      (sql) => {
        if (!sql.includes('"session_started_at"') || !sql.includes('from "session_nodes"')) {
          return null;
        }
        if (sql.includes('"age_namespaces"')) {
          return "dashboards";
        }
        if (sql.includes('"session_canonical_validation_pending"')) {
          return "pending";
        }
        return sql.includes('"updated_at" > ?') ? "after" : "unexpected";
      },
    );
    const expectedProbes = { after: 1, dashboards: 1, pending: 1, unexpected: 0 };
    const expectedRows = { after: 1, dashboards: 0, pending: 0, unexpected: 0 };
    onTestFinished(queries.restore);
    await renameEntry(storePath, 0, "warm age facts");
    expect(factReads).toHaveBeenCalledTimes(1);
    expect(queries.counts).toEqual(expectedProbes);
    expect(queries.rowCounts).toEqual(expectedRows);
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      writeMetadata(storePath, kind, sequence);
      await renameEntry(storePath, 0, `renamed-${sequence}`);
    }
    expect(readEntry(storePath)).toMatchObject({ label: "renamed-3" });
    if (kind === "participant") {
      expect(listSessionParticipantsReadOnly({ agentId: "main", storePath }).get(key(0))).toEqual([
        {
          identity: { type: "agent", id: "worker" },
          contributionCount: 4,
          firstPromptedAt: 0,
          lastPromptedAt: 3,
        },
      ]);
    } else {
      expect(readEntry(storePath)?.owner).toEqual({
        actor: { type: "agent", id: "worker-3" },
        assignedBy: { type: "agent", id: "main" },
        assignedAt: 3,
      });
    }
    expect(factReads).toHaveBeenCalledTimes(1);
    expect(queries.counts).toEqual(expectedProbes);
    expect(queries.rowCounts).toEqual(expectedRows);
  },
);

it("reports a maintenance deadline without an unused revision snapshot", () => {
  const now = Date.now();
  const { database, options } = createStore(1, now);
  const maintenance = agePolicy({ mode: "enforce", pruneAfterMs: DAY_MS });
  writeTransaction(
    (current) => ageFacts.recordSessionEntryMaintenanceAgeFact(current, maintenance, now),
    options,
  );
  const reads = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["revision"],
    (sql) => (/^PRAGMA data_version\b/i.test(sql) ? "revision" : null),
  );
  let admittedReads = 0;
  onTestFinished(reads.restore);
  const result = reclaimMaintenance(
    {
      kind: "maintenance-age",
      databaseOptions: resolveSessionReclamationDatabaseOptions(options),
      materializedPlans: [],
      maintenance,
    },
    {
      beforeMutation() {
        admittedReads = reads.counts.revision;
      },
    },
  );
  expect(result).toMatchObject({
    kind: "maintenance-age",
    nextAt: now + ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
  });
  expect(reads.counts.revision - admittedReads).toBe(0);
});

it.each([
  ["a write crosses the cap", 2, 2, false],
  ["forced maintenance bypasses ordinary-write slack", 51, 50, true],
] as const)("enforces the cap when %s", async (_scenario, count, maxEntries, force) => {
  const { options, storePath } = createStore(count);
  const input = await maintenanceInput(storePath);
  input.maintenanceConfig.maxEntries = maxEntries;
  const maintain = (trigger = false) =>
    writeTransaction((database) => {
      if (trigger && !force) {
        writeFixtureEntry(database, 2);
      }
      return applySessionEntryMaintenance(database, {
        ...input,
        forceMaintenance: trigger && force,
      });
    }, options);
  expect(maintain().archived).toBe(0);
  const ageReads = vi.spyOn(candidates, "readSessionMaintenanceAgeCandidates");
  expect(maintain(true)).toMatchObject({ archived: 1, capped: 1 });
  if (!force) {
    expect(ageReads).toHaveBeenCalledTimes(1);
    const entries = [0, 1, 2].map((index) => readEntry(storePath, index));
    expect(entries.every((entry) => entry !== undefined)).toBe(true);
    expect(entries.filter((entry) => entry?.archivedAt !== undefined)).toEqual([
      expect.objectContaining({ archiveReason: "active-session-cap" }),
    ]);
  }
});

it.each(["foreign backdate", "managed backdate", "shorter age policy"] as const)(
  "reconsiders retention after a %s",
  async (mutation) => {
    const now = Date.now();
    if (mutation === "foreign backdate") {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
    }
    const { database, storePath } = createStore(
      2,
      mutation === "shorter age policy" ? now - 2 * DAY_MS : now,
    );
    await renameEntry(storePath, 0, "warm age facts");
    if (mutation === "managed backdate") {
      await applySessionEntryReplacements({
        storePath,
        sessionKeys: [key(1)],
        skipMaintenance: false,
        update: (entries) => ({
          result: undefined,
          replacements: entries.map(({ entry, sessionKey }) => ({
            sessionKey,
            entry: { ...entry, updatedAt: Date.now() - 31 * DAY_MS },
          })),
        }),
      });
    } else {
      if (mutation === "foreign backdate") {
        using writer = new DatabaseSync(database.path);
        const updatedAt = now - 31 * DAY_MS;
        writer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.updatedAt', ?), updated_at = ? WHERE session_key = ?",
          )
          .run(updatedAt, updatedAt, key(1));
        vi.setSystemTime(now + 30 * 60 * 1_000 + 1);
      } else {
        expect(readEntry(storePath, 1)?.archivedAt).toBeUndefined();
        vi.spyOn(maintenanceRuntime, "resolveMaintenanceConfig").mockReturnValue({
          ...resolveMaintenanceConfigFromInput(),
          pruneAfterMs: DAY_MS,
          archiveDashboardAfterMs: null,
        });
      }
      await renameEntry(storePath, 0, "reconsider after invalidation");
    }
    expect(readEntry(storePath, 1)).toMatchObject({ archiveReason: "age-retention" });
  },
);

it("keeps an age boundary due when it passes between planning and recording the fact", async () => {
  const now = Date.now();
  const { storePath } = createStore(1, now);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.spyOn(maintenanceRuntime, "resolveMaintenanceConfig").mockReturnValue(
    agePolicy({ pruneAfterMs: 1_000 }),
  );
  const record = ageFacts.recordSessionEntryMaintenanceAgeFact;
  vi.spyOn(ageFacts, "recordSessionEntryMaintenanceAgeFact").mockImplementationOnce((...args) => {
    vi.setSystemTime(now + 1_001);
    return record(...args);
  });
  await renameEntry(storePath, 0, "boundary passed during planning");
  expect(readEntry(storePath)?.archivedAt).toBeUndefined();
  await renameEntry(storePath, 0, "reconsider the elapsed boundary");
  expect(readEntry(storePath)).toMatchObject({ archiveReason: "age-retention" });
});

it("does not retain an age fact from a rolled-back archive", async () => {
  const { options, storePath } = createStore(1, Date.now() - 31 * DAY_MS);
  const input = await maintenanceInput(storePath);
  const maintain = (database: ReturnType<typeof openOpenClawAgentDatabase>) =>
    applySessionEntryMaintenance(database, input);
  expect(() =>
    writeTransaction((database) => {
      expect(maintain(database).archived).toBe(1);
      expect(maintain(database).archived).toBe(0);
      throw new Error("roll back archive");
    }, options),
  ).toThrow("roll back archive");
  expect(readEntry(storePath)?.archivedAt).toBeUndefined();
  expect(writeTransaction(maintain, options).archived).toBe(1);
  expect(readEntry(storePath)).toMatchObject({ archiveReason: "age-retention" });
});

it("reconsiders a session unarchived without changing its timestamp", async () => {
  const { storePath } = createStore(1, Date.now() - 31 * DAY_MS);
  await renameEntry(storePath, 0, "archive old session");
  await renameEntry(storePath, 0, "warm archived-only facts");
  const archivedEntry = readEntry(storePath);
  expect(archivedEntry?.archivedAt).toEqual(expect.any(Number));
  const ageReads = vi.spyOn(candidates, "readSessionMaintenanceAgeCandidates");
  await replaceEntryInDatabase(storePath, 0, (entry) => ({
    ...entry,
    archivedAt: undefined,
    archiveReason: undefined,
  }));
  expect(ageReads).toHaveBeenCalledTimes(1);
  expect(readEntry(storePath)).toMatchObject({
    updatedAt: archivedEntry?.updatedAt,
    archivedAt: expect.any(Number),
    archiveReason: "age-retention",
  });
});

it.each([
  ["shared dashboards", 6],
  ["pending dashboard alias", 7],
  ["pending namespace prefixes", 7],
  ["recent activity", 4],
  ["expired recent activity", 22],
  ["disabled ages", Infinity],
] as const)("keeps exact next maintenance deadlines for %s", (scenario, daysUntilDue) => {
  const { options } = createStore(0);
  const now = Date.now();
  const maintenance = agePolicy({ pruneAfterMs: 30 * DAY_MS });
  const result = writeTransaction((database) => {
    const write = (
      sessionKey: string,
      days: number,
      fields: Partial<SessionEntry> = {},
      alias = false,
    ) =>
      writeSessionEntry(
        database,
        sessionKey,
        { sessionId: sessionKey.replaceAll(":", "-"), updatedAt: now - days * DAY_MS, ...fields },
        alias ? { allowStoredAliases: true, canonicalPreviousEntry: null } : undefined,
      );
    write("agent:main:main", 100);
    if (scenario.startsWith("pending") || scenario === "shared dashboards") {
      maintenance.archiveDashboardAfterMs = 7 * DAY_MS;
    }
    if (scenario === "shared dashboards") {
      write("agent:main:dashboard:first", 8, { lastActivityAt: now });
      write("agent:zeta:dashboard:second", 8, { lastInteractionAt: now - DAY_MS });
    } else if (scenario === "pending dashboard alias") {
      write("AGENT:MAIN:DASHBOARD:ALIAS", 8, { lastActivityAt: now }, true);
    } else if (scenario === "pending namespace prefixes") {
      write("agent:main:dashboard:certified", 8, { lastActivityAt: now });
      for (const storedKey of ["agent:", "agent:foo"]) {
        write(storedKey, 0, {}, true);
      }
    } else if (scenario === "recent activity") {
      maintenance.pruneAfterMs = 60 * DAY_MS;
      maintenance.preserveRecentMs = 7 * DAY_MS;
      const fields = [
        "updatedAt",
        "lastActivityAt",
        "lastInteractionAt",
        "sessionStartedAt",
      ] as const;
      for (const [index, field] of fields.entries()) {
        write(key(index), 31, { [field]: now - index * DAY_MS });
      }
    } else {
      maintenance.preserveRecentMs = scenario === "expired recent activity" ? 7 * DAY_MS : null;
      maintenance.pruneAfterMs = scenario === "disabled ages" ? 0 : 30 * DAY_MS;
      write(key(0), 8);
    }
    ageFacts.recordSessionEntryMaintenanceAgeFact(database, maintenance, now);
    return {
      nextAgeAt: ageFacts.readSessionEntryMaintenanceAgeFact(database.db, maintenance)?.next.at,
      nextMaintenanceAt: ageFacts.readSessionEntryMaintenanceNextAgeAt(database, maintenance),
    };
  }, options);
  const expected = now + daysUntilDue * DAY_MS + 1;
  expect(result).toEqual({
    nextAgeAt: expected,
    nextMaintenanceAt: Math.min(expected, now + ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS),
  });
});

it.each([
  "foreign entry",
  "transcript append",
  "protected parent",
  "active ancestor",
  "work-id",
  "lifecycle-id",
] as const)(
  "discards a prepared maintenance snapshot after %s changes its admission",
  async (mutation) => {
    const entryChanged = mutation === "foreign entry";
    const candidateChanged = mutation === "transcript append" || mutation === "protected parent";
    const { database, options, storePath } = createStore(
      entryChanged ? 1 : 2,
      Date.now() - 31 * DAY_MS,
    );
    const childKey = key(1);
    if (!entryChanged) {
      writeFixtureEntry(database, 1, candidateChanged ? {} : { parentSessionKey: key(0) });
    }
    const operation = await createPlanningOperation(
      options,
      entryChanged
        ? {}
        : candidateChanged
          ? { activeSessionKeys: [childKey] }
          : { preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] } },
    );
    const prepared = prepareMaintenance(operation);
    const writer = mutation === "foreign entry" ? new DatabaseSync(database.path) : undefined;
    try {
      if (entryChanged) {
        expect(database.db.isTransaction).toBe(false);
      }
      if (writer) {
        writer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'newer') WHERE session_key = ?",
          )
          .run(key(0));
        // Certify the foreign postimage, as the ordinary entry owner does.
        writer
          .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
          .run(key(0));
      } else if (mutation === "transcript append") {
        expect(
          appendTranscriptEventSync(
            { storePath, sessionKey: key(0), sessionId: "cadence-0" },
            { type: "custom", id: "concurrent-event", data: { synthetic: true } },
          ).ok,
        ).toBe(true);
      } else if (mutation === "protected parent") {
        writeFixtureEntry(database, 1, { parentSessionKey: key(0) });
      } else {
        operation.input.activeSessionKeys = mutation === "active ancestor" ? [childKey] : [];
        operation.input.preservation = {
          providerKeys: [],
          workIdentities: mutation === "work-id" ? ["cadence-0"] : [],
          lifecycleIdentities: mutation === "lifecycle-id" ? ["cadence-0"] : [],
        };
      }
      expect(reclaimMaintenance(operation, {}, prepared)).toEqual({
        kind: "maintenance-plan-stale",
      });
      if (entryChanged) {
        expect(readEntry(storePath)?.label).toBe("newer");
      }
      expect(readEntry(storePath)?.archivedAt).toBeUndefined();
    } finally {
      prepared.release();
      writer?.close();
    }
    if (entryChanged) {
      const fresh = prepareMaintenance(operation);
      using _ = { [Symbol.dispose]: fresh.release };
      expect(reclaimMaintenance(operation, {}, fresh)).toMatchObject({
        kind: "maintenance-plan",
        value: { archived: 1 },
      });
      expect(readEntry(storePath)).toMatchObject({
        label: "newer",
        archiveReason: "age-retention",
      });
    }
  },
);

it("commits a prepared plan after an unrelated foreign write", async () => {
  const { database, options } = createStore(1, Date.now() - 31 * DAY_MS);
  const operation = await createPlanningOperation(options);
  const prepared = prepareMaintenance(operation);
  using writer = new DatabaseSync(database.path);
  using _ = { [Symbol.dispose]: prepared.release };
  writer.exec("CREATE TABLE maintenance_unrelated_noise (value INTEGER)");
  expect(reclaimMaintenance(operation, {}, prepared)).toMatchObject({
    kind: "maintenance-plan",
    value: { archived: 1 },
  });
});
