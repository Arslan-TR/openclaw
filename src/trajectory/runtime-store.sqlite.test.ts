// SQLite trajectory runtime tests cover session-scoped event row storage.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  loadSqliteTrajectoryRuntimeEventRowsSync,
  loadSqliteTrajectoryRuntimeEvents,
} from "./runtime-store.sqlite.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  createTrajectoryEvent,
} from "./runtime-store.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-trajectory-sqlite-");

describe("SQLite trajectory runtime store", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rolls back a later batch failure and retries without losing or duplicating events", async () => {
    const scope = { sessionId: "session-1", storePath };
    const existing = createTrajectoryEvent({ type: "existing" });
    appendSqliteTrajectoryRuntimeEvents(scope, [existing]);
    const events = Array.from({ length: 100 }, (_, index) =>
      createTrajectoryEvent({ type: `pending-${index}` }),
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    database.db.exec(`CREATE TEMP TRIGGER reject_trajectory_append
      BEFORE INSERT ON trajectory_runtime_events WHEN NEW.seq = 65
      BEGIN SELECT RAISE(ABORT, 'synthetic later append failure'); END`);
    try {
      expect(() => appendSqliteTrajectoryRuntimeEvents(scope, events)).toThrow(
        "synthetic later append failure",
      );
      await expect(loadSqliteTrajectoryRuntimeEvents(scope)).resolves.toEqual([existing]);
    } finally {
      database.db.exec("DROP TRIGGER reject_trajectory_append");
    }
    appendSqliteTrajectoryRuntimeEvents(scope, events);
    expect(loadSqliteTrajectoryRuntimeEventRowsSync(scope)).toEqual(
      [existing, ...events].map((event, seq) => ({ event, seq })),
    );
  });

  it("rejects a foreign owner for a non-shared agent store on append and read", async () => {
    const foreign = { agentId: "ops", sessionId: "session-1", storePath };
    expect(() =>
      appendSqliteTrajectoryRuntimeEvents(foreign, [createTrajectoryEvent({ type: "foreign" })]),
    ).toThrow(/store path belongs to agent main; requested agent ops/);
    expect(() => loadSqliteTrajectoryRuntimeEventRowsSync(foreign)).toThrow(
      /store path belongs to agent main; requested agent ops/,
    );
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1", storePath }),
    ).resolves.toEqual([]);
  });

  it("trims the retained byte window without fetching UTF-8 event bodies", async () => {
    const history = Array.from({ length: 64 }, (_, index) =>
      createTrajectoryEvent({ type: `old-${index}`, payloadSize: 64 * 1024 }),
    );
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, history);
    const newest = createTrajectoryEvent({ type: "newest" });
    const retained = [...history.slice(-2), newest];
    const maxRuntimeBytes = retained.reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
      0,
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    const counter = trackSqliteStatementExecutions(database.db, ["window"], (sql) =>
      /^select\b/i.test(sql) && sql.includes('"trajectory_runtime_events"') ? "window" : null,
    );
    try {
      appendSqliteTrajectoryRuntimeEvents({ maxRuntimeBytes, sessionId: "session-1", storePath }, [
        newest,
      ]);
      expect(counter.counts.window).toBe(1);
      expect(counter.textBytes.window).toBe(0);
    } finally {
      counter.restore();
    }
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual(retained);
  });

  it("keeps the exact UTF-8 byte window when a batch exceeds its budget", async () => {
    const events = ["old", "middle", "newest"].map((type) => {
      const event = createTrajectoryEvent({ type });
      event.data = { payload: "日本語🦞".repeat(20) };
      return event;
    });
    const maxRuntimeBytes = events
      .slice(-2)
      .reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), "utf8") + 1, 0);
    appendSqliteTrajectoryRuntimeEvents(
      { maxRuntimeBytes, sessionId: "session-1", storePath },
      events,
    );
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual(events.slice(-2));
  });

  it("reads a missing trajectory store without creating an agent database", () => {
    const missingStorePath = path.join(tempDir, "agents", "missing", "sessions", "sessions.json");
    const missingDatabasePath = path.join(
      tempDir,
      "agents",
      "missing",
      "agent",
      "openclaw-agent.sqlite",
    );

    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        agentId: "missing",
        sessionId: "missing-session",
        storePath: missingStorePath,
      }),
    ).toEqual([]);
    expect(fs.existsSync(missingDatabasePath)).toBe(false);
  });

  it("applies maxEvents to a trailing window", () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "event-1" }),
      createTrajectoryEvent({ type: "event-2" }),
      createTrajectoryEvent({ type: "event-3" }),
    ]);

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      sessionId: "session-1",
      storePath,
      tailEvents: 3,
      maxEvents: 1,
    });

    expect(rows.map((row) => row.event.type)).toEqual(["event-3"]);
  });

  function sqlitePath(): string {
    return path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  }
});

describe("SQLite trajectory runtime reader byte and count budgets", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:session-1", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
  });

  it("accepts a SQLite runtime event-count budget equal to the row count and rejects one over", () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ seq: 1, type: "boundary-row-1" }),
      createTrajectoryEvent({ seq: 2, type: "boundary-row-2" }),
    ]);

    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventCount: 2,
      }).length,
    ).toBe(2);
    expect(() =>
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventCount: 1,
      }),
    ).toThrow(/runtime store has too many events to export/u);
  });

  // OCTET_LENGTH measures the database encoding, so a UTF-16 store would otherwise
  // reject an ASCII transcript near half the documented UTF-8 cap and undercount
  // CJK-heavy text. Admission must measure the UTF-8 byte budget across encodings.
  it.each([
    { encoding: "UTF-16le" as const, payload: "a".repeat(200), label: "ascii" },
    { encoding: "UTF-16le" as const, payload: "日本語🦞".repeat(40), label: "cjk" },
  ])(
    "measures the UTF-8 byte budget in $encoding for $label payloads",
    async ({ encoding, payload }) => {
      storePath = path.join(tempDir, `${encoding}.sqlite`);
      const seed = new DatabaseSync(storePath);
      try {
        seed.exec(
          `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
        );
      } finally {
        seed.close();
      }
      await replaceSessionEntry(
        { sessionKey: "agent:main:main", storePath },
        { sessionId: "session-1", updatedAt: 10 },
      );
      const events = ["alpha", "beta"].map((type) => {
        const event = createTrajectoryEvent({ type });
        event.data = { payload };
        return event;
      });
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, events);
      const jsonlSize = events.reduce(
        (total, event, index) =>
          total + Buffer.byteLength(JSON.stringify(event), "utf8") + (index > 0 ? 1 : 0),
        0,
      );
      // Budget equals the true UTF-8 size: admission must accept it in every encoding.
      expect(
        loadSqliteTrajectoryRuntimeEventRowsSync({
          sessionId: "session-1",
          storePath,
          maxEventBytes: jsonlSize,
        }).length,
      ).toBe(events.length);
      // One byte below the UTF-8 size must reject in every encoding.
      expect(() =>
        loadSqliteTrajectoryRuntimeEventRowsSync({
          sessionId: "session-1",
          storePath,
          maxEventBytes: jsonlSize - 1,
        }),
      ).toThrow(/runtime store is too large to export/u);
    },
  );
});

/** Inserts a competing oversized row via a second writable connection, called between the budget aggregate and payload SELECT. */
function createCompetingRowInjector(
  dbPath: string,
  sessionId: string,
): { inject: () => void; close: () => void } {
  const writerDb = openNodeSqliteDatabase(dbPath);
  const competingEvent = createTrajectoryEvent({ seq: 2, type: "competing-row", payloadSize: 256 });
  const competingJson = JSON.stringify(competingEvent);
  const insert = writerDb.prepare(
    "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  return {
    inject: () => insert.run(sessionId, 2, competingEvent.runId ?? null, competingJson, Date.now()),
    close: () => writerDb.close(),
  };
}

describe("SQLite trajectory runtime reader snapshot consistency", () => {
  let tempDir: string;
  let storePath: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:session-1", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
    dbPath = path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  });

  it("keeps the production reader's budget aggregate and payload SELECT in one deferred snapshot so a competing writer cannot cross the budget", () => {
    const event = createTrajectoryEvent({ seq: 1, type: "snapshot-row-1", payloadSize: 100 });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [event]);
    const rowBytes = Buffer.byteLength(JSON.stringify(event), "utf8");

    // Spy on the cached connection's prepare() to inject a competing row between the budget aggregate and payload SELECT.
    const database = openOpenClawAgentDatabase({ agentId: "main", path: dbPath });
    const injector = createCompetingRowInjector(dbPath, "session-1");
    const prepare = database.db.prepare.bind(database.db);
    let injected = false;
    const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      // Inject after the budget aggregate, before the payload SELECT iterates rows.
      if (!injected && sql.includes(`"seq", "event_json"`)) {
        injector.inject();
        injected = true;
      }
      return statement;
    });

    try {
      // The deferred transaction snapshot prevents the competing row from being visible.
      const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventBytes: rowBytes,
      });

      expect(rows.map((row) => row.event.type)).toEqual(["snapshot-row-1"]);
      expect(injected).toBe(true);
    } finally {
      prepareSpy.mockRestore();
      injector.close();
    }
  });
});
