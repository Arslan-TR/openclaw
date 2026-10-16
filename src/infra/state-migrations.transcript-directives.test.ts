import { AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../scripts/lib/sqlite-transcript-payload.mjs";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import { prepareTranscriptPayload } from "../config/sessions/transcript-payload.js";
import { deriveTranscriptPredicateFields } from "../config/sessions/transcript-predicate-fields.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  assertAgentDatabaseMaintenanceAuthority,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { LEGACY_PARTICIPANTS_SCHEMA } from "../state/openclaw-agent-schema-history.js";
import { seedOpenClawAgentSchemaV21 } from "../state/openclaw-agent-schema-v21.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { EngineConnection } from "./sql-connection.js";
import { TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE } from "./state-migrations.transcript-directives-archives.js";
import { migrateHistoricalTranscriptDirectives as migrate } from "./state-migrations.transcript-directives.js";

const tempDirs: string[] = [];

type FixtureEvent = Record<string, unknown>;

function messageEvent(params: {
  content: unknown;
  id: string;
  parentId?: string | null;
  role: "assistant" | "toolResult" | "user";
  timestamp: number;
}): FixtureEvent {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId ?? null,
    timestamp: params.timestamp,
    message: {
      role: params.role,
      content: params.content,
      timestamp: params.timestamp,
    },
  };
}

function assistantEvent(id: string, text: string, timestamp = 1) {
  return messageEvent({ id, role: "assistant", timestamp, content: [{ type: "text", text }] });
}
function createFixture() {
  const stateDir = makeTempDir(tempDirs, "transcript-directive-migration-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const opened = openOpenClawAgentDatabase({ agentId: "main", env });
  return { stateDir, env, opened, databasePath: opened.path };
}
function insertArchive(
  db: EngineConnection,
  sessionId: string,
  generation: string,
  bytes: Buffer,
  name: string,
  createdAt: number,
  publishedAt: number | null,
) {
  db.prepare(`INSERT INTO session_transcript_archives(
    session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
    archive_name,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    sessionId,
    generation,
    `agent:main:${sessionId}`,
    "deleted",
    "identity",
    bytes,
    createHash("sha256").update(bytes).digest("hex"),
    name,
    createdAt,
    publishedAt,
  );
}
function expireMaintenance(env: NodeJS.ProcessEnv) {
  openOpenClawStateDatabase({ env })
    .db.prepare("UPDATE state_leases SET expires_at = ? WHERE scope = ? AND lease_key = ?")
    .run(
      Date.now() - 1,
      AGENT_DATABASE_MAINTENANCE_LEASE.scope,
      AGENT_DATABASE_MAINTENANCE_LEASE.key,
    );
}

function insertSession(
  database: import("node:sqlite").DatabaseSync,
  params: {
    events: FixtureEvent[];
    generation: string;
    sessionId: string;
    reconcile?: boolean;
    legacy?: boolean;
  },
): void {
  const sessionKey = `agent:main:${params.sessionId}`;
  database
    .prepare(`INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at)
       VALUES(?,?,?,?)`)
    .run(sessionKey, params.sessionId, "{}", 1);
  database
    .prepare(`INSERT INTO session_windows(session_id,session_key,created_at,updated_at,transcript_updated_at)
       VALUES(?,?,?,?,?)`)
    .run(params.sessionId, sessionKey, 1, 1, 1);
  database
    .prepare(`INSERT INTO transcript_rewrite_watermarks(session_id,generation,updated_at)
       VALUES(?,?,?)`)
    .run(params.sessionId, params.generation, 1);
  for (const [seq, event] of params.events.entries()) {
    const eventJson = JSON.stringify(event);
    if (params.legacy) {
      database
        .prepare(`INSERT INTO transcript_events(session_id,seq,event_json,created_at)
         VALUES(?,?,?,?)`)
        .run(params.sessionId, seq, eventJson, Number(event.timestamp ?? 1));
    } else {
      database
        .prepare(`INSERT INTO transcript_events
        (session_id,seq,event_json,created_at,navigation_type,navigation_custom_type,
         navigation_display,message_role,navigation_last_type,navigation_last_custom_type,navigation_valid)
        VALUES ($sessionId,$seq,$eventJson,$createdAt,$navigation_type,$navigation_custom_type,
          $navigation_display,$message_role,$navigation_last_type,$navigation_last_custom_type,$navigation_valid)`)
        .run({
          sessionId: params.sessionId,
          seq,
          eventJson,
          createdAt: Number(event.timestamp ?? 1),
          ...deriveTranscriptPredicateFields(eventJson),
        });
    }
  }
  if (params.reconcile !== false) {
    reconcileSessionTranscriptIndexInTransaction(database, params.sessionId);
  }
}

function openLegacyAgentDatabase(stateDir: string, agentId = "main") {
  // These active stores have known-empty deletion history before their legacy bytes exist.
  openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const databasePath = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = openNodeSqliteDatabase(databasePath);
  seedOpenClawAgentSchemaV21(database, agentId);
  removeCanonicalValidationFromHistoricalAgentFixture(database);
  database.exec(`
    DROP TABLE session_participants;
    ${LEGACY_PARTICIPANTS_SCHEMA}
    PRAGMA user_version = 17;
    UPDATE schema_meta SET schema_version = 17 WHERE meta_key = 'primary';
  `);
  return { db: database, path: databasePath };
}

function readRows(databasePath: string, sql: string, ...params: SQLInputValue[]) {
  using db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  return db.prepare(sql).all(...params);
}
const readRow = (...args: Parameters<typeof readRows>) => readRows(...args)[0];
function readEventJson(databasePath: string, sessionId: string, seq: number): string {
  using database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  const row = database
    .prepare(
      `SELECT ${sqliteTranscriptPayloadColumns(database)} FROM transcript_events WHERE session_id = ? AND seq = ?`,
    )
    .get(sessionId, seq);
  if (!row) {
    throw new Error(`Missing transcript fixture ${sessionId}:${seq}`);
  }
  return readSqliteTranscriptPayload(row);
}
function readGeneration(databasePath: string, sessionId: string) {
  return readRow(
    databasePath,
    "SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?",
    sessionId,
  )!.generation;
}
function readMigrationCursor(databasePath: string): unknown {
  const row = readRow(
    databasePath,
    "SELECT app_version FROM schema_meta WHERE meta_key = 'historical-transcript-directives-v1'",
  ) as { app_version: string } | undefined;
  return row ? JSON.parse(row.app_version) : undefined;
}
function hasTranscriptArchivesTable(databasePath: string) {
  return Boolean(
    readRow(
      databasePath,
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
      "session_transcript_archives",
    ),
  );
}
function seedArchiveCursor(db: EngineConnection) {
  db.prepare(`INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
    VALUES(?, 'agent', 1, 'main', ?, 1, 1)`).run(
    "historical-transcript-directives-v1",
    JSON.stringify({ generation: "", phase: "archives", sessionId: "" }),
  );
}
function bindCompetingWriter(stateDir: string, env: NodeJS.ProcessEnv) {
  // Bind before entering maintenance so the contender does not inherit its authority.
  const claim = AsyncResource.bind(claimOpenClawAgentDatabaseLease);
  return () =>
    claim({ agentId: "competitor", path: path.join(stateDir, "competitor.sqlite"), env });
}

function parseArchive(content: string): FixtureEvent[] {
  return content
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureEvent);
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("historical transcript directive migration", () => {
  it.each(["identity", "zstd"])(
    "migrates %s assistant rows and archives while preserving code and derived indexes",
    async (storage) => {
      const { env, opened, databasePath } = createFixture();
      const tagged = assistantEvent(
        "tagged-assistant",
        "[[reply_to_current]]\n[[reply_to: message-7 ]]\n[[audio_as_voice]]\nFinal answer [[react: 👍]]",
        10,
      );
      const user = messageEvent({
        id: "user-marker",
        parentId: "tagged-assistant",
        role: "user",
        timestamp: 11,
        content: "Keep [[reply_to_current]] and [[react: 👍]]",
      });
      const tool = messageEvent({
        id: "tool-marker",
        parentId: "user-marker",
        role: "toolResult",
        timestamp: 12,
        content: [{ type: "text", text: "Keep [[audio_as_voice]]" }],
      });
      const codeText = [
        "Use `[[reply_to_current]]` and `[[react: 👍]]` literally.",
        "```text",
        "[[audio_as_voice]]",
        "[[react_to_current: ✅]]",
        "```",
      ].join("\n");
      const code = assistantEvent("code-assistant", codeText, 20);
      const reaction = assistantEvent(
        "reaction-assistant",
        "Reacted [[react_to_current: ✅]] without a fact",
        30,
      );
      if (storage === "zstd") {
        for (const event of [tagged, user, tool, code, reaction]) {
          event.fixturePadding = "compression fixture ".repeat(256);
        }
      }
      for (const [name, events] of [
        ["tagged", [tagged, user, tool]],
        ["code", [code]],
        ["reaction", [reaction]],
      ] as const) {
        insertSession(requireNativeSqliteDatabase(opened.db), {
          events: [...events],
          generation: `${name}-before`,
          sessionId: `${name}-session`,
        });
      }
      if (storage === "zstd") {
        const update = opened.db.prepare(
          "UPDATE transcript_events SET event_json = NULL, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = ?",
        );
        for (const row of opened.db
          .prepare("SELECT session_id, seq, event_json FROM transcript_events")
          .all()) {
          if (
            typeof row.event_json !== "string" ||
            typeof row.session_id !== "string" ||
            typeof row.seq !== "number"
          ) {
            throw new Error("Invalid transcript fixture row");
          }
          const payload = prepareTranscriptPayload(opened.db, row.event_json);
          expect(payload.event_zstd).not.toBeNull();
          update.run(
            payload.event_zstd,
            payload.event_utf8_bytes,
            payload.navigation_json,
            row.session_id,
            row.seq,
          );
        }
      }

      const archivedTagged = assistantEvent(
        "archived-tagged",
        "[[reply_to: archive-2]] Archived answer",
        40,
      );
      const archivedCode = assistantEvent("archived-code", "`[[reply_to_current]]`", 41);
      const archivedUser = messageEvent({
        id: "archived-user",
        role: "user",
        timestamp: 42,
        content: "[[audio_as_voice]]",
      });
      const archiveContent = `${[archivedTagged, archivedCode, archivedUser]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`;
      const archiveBytes = Buffer.from(archiveContent, "utf8");
      const archiveName = "archived-session.jsonl.deleted.2026-01-01T00-00-00.000Z.archive-gen";
      insertArchive(
        opened.db,
        "archived-session",
        "archive-gen",
        archiveBytes,
        archiveName,
        40,
        50,
      );
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
        agentId: "main",
        path: databasePath,
      });
      fs.mkdirSync(archiveDirectory, { recursive: true });
      const archivePath = path.join(archiveDirectory, archiveName);
      fs.writeFileSync(archivePath, archiveBytes);

      const codeEventJson = JSON.stringify(code);
      const userEventJson = JSON.stringify(user);
      const toolEventJson = JSON.stringify(tool);
      const archivedCodeJson = JSON.stringify(archivedCode);
      const archivedUserJson = JSON.stringify(archivedUser);
      closeOpenClawAgentDatabasesForTest();

      const result = await migrate({ env });
      expect(result.warnings).toEqual([]);
      expect(result.changes).toHaveLength(2);
      const recoveryDirectories = () =>
        fs
          .readdirSync(path.dirname(databasePath))
          .filter((name) => name.startsWith("openclaw-transcript-directives-recovery-"));
      const backups = recoveryDirectories();
      expect(backups).toHaveLength(1);
      const backupPath = path.join(path.dirname(databasePath), backups[0]!, "database.sqlite");
      expect(readEventJson(backupPath, "tagged-session", 0)).toBe(JSON.stringify(tagged));
      expect(readEventJson(backupPath, "reaction-session", 0)).toBe(JSON.stringify(reaction));
      expect(readRow(backupPath, "SELECT archive_blob FROM session_transcript_archives")).toEqual({
        archive_blob: new Uint8Array(archiveBytes),
      });

      const migratedTagged = JSON.parse(readEventJson(databasePath, "tagged-session", 0)) as {
        message: Record<string, unknown>;
      };
      expect(migratedTagged.message).toMatchObject({
        content: [{ type: "text", text: "Final answer" }],
        openclawDelivery: {
          audioAsVoice: true,
          replyToId: "message-7",
        },
      });
      expect([
        readEventJson(databasePath, "tagged-session", 1),
        readEventJson(databasePath, "tagged-session", 2),
        readEventJson(databasePath, "code-session", 0),
      ]).toEqual([userEventJson, toolEventJson, codeEventJson]);
      const migratedReaction = JSON.parse(readEventJson(databasePath, "reaction-session", 0)) as {
        message: Record<string, unknown>;
      };
      expect(migratedReaction.message).toMatchObject({
        content: [{ type: "text", text: "Reacted  without a fact" }],
      });
      expect(migratedReaction.message).not.toHaveProperty("openclawDelivery");

      expect(readGeneration(databasePath, "tagged-session")).not.toBe("tagged-before");
      expect(readGeneration(databasePath, "reaction-session")).not.toBe("reaction-before");
      expect(readGeneration(databasePath, "code-session")).toBe("code-before");

      expect(
        readRows(
          databasePath,
          "SELECT session_id FROM session_transcript_fts WHERE session_transcript_fts MATCH ?",
          "Final",
        ),
      ).toContainEqual({ session_id: "tagged-session" });
      const archivedRow = readRow(
        databasePath,
        "SELECT archive_blob,archive_sha256 FROM session_transcript_archives WHERE session_id = ?",
        "archived-session",
      ) as { archive_blob: Uint8Array; archive_sha256: string };
      expect(createHash("sha256").update(archivedRow.archive_blob).digest("hex")).toBe(
        archivedRow.archive_sha256,
      );
      const migratedArchiveContent = Buffer.from(archivedRow.archive_blob).toString("utf8");
      const migratedArchive = parseArchive(migratedArchiveContent);
      expect(migratedArchive[0]).toMatchObject({
        message: {
          content: [{ type: "text", text: "Archived answer" }],
          openclawDelivery: { replyToId: "archive-2" },
        },
      });
      expect(migratedArchiveContent).toContain(archivedCodeJson);
      expect(migratedArchiveContent).toContain(archivedUserJson);
      expect(readSessionArchiveContentSync(archivePath)).toBe(migratedArchiveContent);

      const generationsAfterFirstRun = {
        tagged: readGeneration(databasePath, "tagged-session"),
        reaction: readGeneration(databasePath, "reaction-session"),
      };
      const archiveBytesAfterFirstRun = fs.readFileSync(archivePath);
      await expect(migrate({ env })).resolves.toEqual({
        changes: [],
        warnings: [],
      });
      expect(readGeneration(databasePath, "tagged-session")).toBe(generationsAfterFirstRun.tagged);
      expect(readGeneration(databasePath, "reaction-session")).toBe(
        generationsAfterFirstRun.reaction,
      );
      expect(fs.readFileSync(archivePath)).toEqual(archiveBytesAfterFirstRun);
      expect(recoveryDirectories()).toEqual(backups);
    },
  );

  it("completes a pre-stuck archives cursor when the optional table is absent", async () => {
    const { env, opened, databasePath } = createFixture();
    opened.db.exec("DROP TABLE session_transcript_archives");
    seedArchiveCursor(opened.db);
    closeOpenClawAgentDatabasesForTest();

    await expect(migrate({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete" });
    expect(hasTranscriptArchivesTable(databasePath)).toBe(false);
  });

  it("rolls back same-version convergence when maintenance expires before commit", async () => {
    const { stateDir, env, opened, databasePath } = createFixture();
    opened.db.exec(`
      DROP TRIGGER session_conversations_route_context_invalidate_after_update;
      ALTER TABLE session_conversations DROP COLUMN route_context_json;
    `);
    closeOpenClawAgentDatabasesForTest();

    const claimCompetingLease = bindCompetingWriter(stateDir, env);
    let competingLeaseId: string | undefined;
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    const originalAssert = agentDatabaseLease.assertAgentDatabaseMaintenanceAuthorityIfPresent;
    const authority = vi
      .spyOn(agentDatabaseLease, "assertAgentDatabaseMaintenanceAuthorityIfPresent")
      .mockImplementation(() => {
        expireMaintenance(env);
        competingLeaseId = claimCompetingLease();
        originalAssert();
      });

    const result = await migrate({ env }).finally(() => authority.mockRestore());

    expect(result.warnings.some((warning) => warning.includes("maintenance lease"))).toBe(true);
    expect(competingLeaseId).toBeDefined();
    expect(
      readRow(
        databasePath,
        "SELECT 1 FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
      ),
    ).toBeUndefined();
    expect(readRow(databasePath, "PRAGMA user_version")).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(
      readRow(
        databasePath,
        "SELECT name FROM sqlite_schema WHERE name = 'session_conversations_route_context_invalidate_after_update'",
      ),
    ).toBeUndefined();
    releaseOpenClawAgentDatabaseLease(competingLeaseId as string, { env });
  });

  it("surfaces lease inspection failures from preflight", async () => {
    const { env, databasePath } = createFixture();
    closeOpenClawAgentDatabasesForTest();
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    vi.spyOn(agentDatabaseLease, "assertNoOpenClawAgentDatabaseLeases").mockImplementation(() => {
      throw new Error("shared-state lease inspection failed");
    });

    const result = await migrate({ env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        `Skipped historical transcript directive migration preflight for ${databasePath}: Error: shared-state lease inspection failed`,
      ),
    ]);
    expect(
      readRow(
        databasePath,
        "SELECT 1 FROM schema_meta WHERE meta_key = ?",
        "historical-transcript-directives-v1",
      ),
    ).toBeUndefined();
  });

  it("leaves canonical archives and their active writer untouched", async () => {
    const { env, opened } = createFixture();
    const archived = assistantEvent("archived-canonical", "Already canonical");
    const archiveBytes = Buffer.from(`${JSON.stringify(archived)}\n`, "utf8");
    insertArchive(
      opened.db,
      "archived-canonical",
      "generation",
      archiveBytes,
      "canonical.jsonl.deleted.2026-01-01T00-00-00.000Z.generation",
      1,
      null,
    );

    await expect(migrate({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    expect(opened.db.isOpen).toBe(true);
    expect(
      opened.db
        .prepare("SELECT 1 FROM schema_meta WHERE meta_key = ?")
        .get("historical-transcript-directives-v1"),
    ).toBeUndefined();
  });

  it("continues preflight after an unreadable target", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-preflight-targets-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openLegacyAgentDatabase(stateDir, "second");
    const databasePath = opened.path;
    const unreadablePath = path.join(stateDir, "unreadable", "agent.sqlite");
    fs.mkdirSync(path.dirname(unreadablePath), { recursive: true });
    fs.writeFileSync(unreadablePath, "not a sqlite database");
    opened.db.close();

    const result = await migrate({
      env,
      configuredAgentDatabaseTargets: [
        { agentId: "first", path: unreadablePath },
        { agentId: "second", path: databasePath },
      ],
    });

    expect(result.warnings.some((warning) => warning.includes("preflight"))).toBe(true);
    expect(readRow(databasePath, "PRAGMA user_version")?.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  });

  it("prunes a stale writer lease before completing an empty database", async () => {
    const { env, databasePath } = createFixture();
    closeOpenClawAgentDatabasesForTest();
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: databasePath,
      env,
    });
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE agent_database_leases SET owner_pid = ? WHERE lease_id = ?")
      .run(2_147_483_647, leaseId);

    await expect(migrate({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete" });
  });

  it("rolls back a transcript transaction when maintenance expires before commit", async () => {
    const { stateDir, env, opened } = createFixture();
    insertSession(requireNativeSqliteDatabase(opened.db), {
      events: [assistantEvent("assistant-expired", "[[reply_to_current]] Migrating")],
      generation: "before",
      sessionId: "session-expired",
    });
    const originalEventJson = readEventJson(opened.path, "session-expired", 0);
    closeOpenClawAgentDatabasesForTest();

    const claimCompetingLease = bindCompetingWriter(stateDir, env);
    let competingLeaseId: string | undefined;
    const originalAssert = assertAgentDatabaseMaintenanceAuthority;
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    const authority = vi
      .spyOn(agentDatabaseLease, "assertAgentDatabaseMaintenanceAuthority")
      .mockImplementation(() => {
        originalAssert();
        if (authority.mock.calls.length !== 1) {
          return;
        }
        expireMaintenance(env);
        competingLeaseId = claimCompetingLease();
      });

    const result = await migrate({ env }).finally(() => {
      authority.mockRestore();
    });

    expect(result.warnings).toHaveLength(2);
    expect(
      result.warnings.every(
        (warning) => warning.includes("maintenance lease") && warning.includes("was lost"),
      ),
    ).toBe(true);
    expect(competingLeaseId).toBeDefined();
    expect(readEventJson(opened.path, "session-expired", 0)).toBe(originalEventJson);
    expect(
      readRow(
        opened.path,
        "SELECT 1 FROM schema_meta WHERE meta_key = ?",
        "historical-transcript-directives-v1",
      ),
    ).toBeUndefined();
    releaseOpenClawAgentDatabaseLease(competingLeaseId as string, { env });
  });

  it("preserves a published archive when maintenance expires before rename", async () => {
    const { stateDir, env, opened } = createFixture();
    const archived = assistantEvent("archived-expired", "[[reply_to_current]] Archived");
    const archiveBytes = Buffer.from(`${JSON.stringify(archived)}\n`, "utf8");
    const archiveName = "expired.jsonl.deleted.2026-01-01T00-00-00.000Z.generation";
    insertArchive(opened.db, "archived-expired", "generation", archiveBytes, archiveName, 1, 1);
    seedArchiveCursor(opened.db);
    const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
      agentId: "main",
      path: opened.path,
    });
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const archivePath = path.join(archiveDirectory, archiveName);
    fs.writeFileSync(archivePath, archiveBytes);
    closeOpenClawAgentDatabasesForTest();

    const claimCompetingLease = bindCompetingWriter(stateDir, env);
    let competingLeaseId: string | undefined;
    const originalAssert = assertAgentDatabaseMaintenanceAuthority;
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    const authority = vi
      .spyOn(agentDatabaseLease, "assertAgentDatabaseMaintenanceAuthority")
      .mockImplementation(() => {
        if (!competingLeaseId && new Error().stack?.includes("beforeRename")) {
          expireMaintenance(env);
          competingLeaseId = claimCompetingLease();
        }
        originalAssert();
      });

    const result = await migrate({ env }).finally(() => {
      authority.mockRestore();
    });

    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(
      result.warnings.every(
        (warning) => warning.includes("maintenance lease") && warning.includes("was lost"),
      ),
    ).toBe(true);
    expect(competingLeaseId).toBeDefined();
    expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
    expect(readMigrationCursor(opened.path)).toEqual({
      generation: "",
      phase: "archives",
      sessionId: "",
    });
    releaseOpenClawAgentDatabaseLease(competingLeaseId as string, { env });
  });

  it("renews maintenance through a blocked schema upgrade and fences the final transcript batch", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-lease-renewal-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openLegacyAgentDatabase(stateDir);
    const batchSize = TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE;
    const sessionIdAt = (index: number) =>
      `session-${String(index).padStart(String(batchSize).length, "0")}`;
    for (let index = 0; index <= batchSize; index += 1) {
      insertSession(requireNativeSqliteDatabase(opened.db), {
        events: [assistantEvent(`assistant-${index}`, "[[reply_to_current]] Migrating", index + 1)],
        generation: "before",
        sessionId: sessionIdAt(index),
        reconcile: false,
        legacy: true,
      });
    }
    opened.db.close();

    const stateLease = await import("../state/openclaw-state-lease.js");
    const withLease = stateLease.withOpenClawStateLease;
    vi.spyOn(stateLease, "withOpenClawStateLease").mockImplementationOnce((options, operation) =>
      withLease({ ...options, leaseMs: 1_000 }, operation),
    );
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    const originalRenew = agentDatabaseLease.renewAgentDatabaseMaintenanceAuthorityIfPresent;
    let originalExpiresAt = 0;
    vi.spyOn(
      agentDatabaseLease,
      "renewAgentDatabaseMaintenanceAuthorityIfPresent",
    ).mockImplementationOnce(() => {
      originalExpiresAt = Number(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT expires_at FROM state_leases WHERE scope = ? AND lease_key = ?")
          .get(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key)
          ?.expires_at,
      );
      // Parent fake timers cannot control the real heartbeat Worker.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_250);
      originalRenew();
    });

    let competingWriterError: unknown;
    const claimCompetingLease = bindCompetingWriter(stateDir, env);
    let competingLeaseId: string | undefined;
    let cursorAtCompetition: unknown;
    let competedAt = 0;
    const batchCursor = { phase: "transcripts", sessionId: sessionIdAt(batchSize - 1) };
    const scheduleImmediate = globalThis.setImmediate;
    vi.spyOn(globalThis, "setImmediate").mockImplementation((callback, ...args) =>
      scheduleImmediate(() => {
        if (!competedAt && isDeepStrictEqual(readMigrationCursor(opened.path), batchCursor)) {
          cursorAtCompetition = readMigrationCursor(opened.path);
          competedAt = Date.now();
          try {
            competingLeaseId = claimCompetingLease();
          } catch (error) {
            competingWriterError = error;
          }
        }
        callback(...args);
      }),
    );

    await expect(migrate({ env })).resolves.toMatchObject({
      warnings: [],
    });

    expect(originalExpiresAt).toBeGreaterThan(0);
    expect(competedAt).toBeGreaterThan(originalExpiresAt);
    expect(cursorAtCompetition).toEqual(batchCursor);
    expect(competingWriterError).toEqual(
      expect.objectContaining({ message: expect.stringContaining("maintenance is in progress") }),
    );
    expect(competingLeaseId).toBeUndefined();
    expect(readMigrationCursor(opened.path)).toEqual({ phase: "complete" });
    expect(JSON.parse(readEventJson(opened.path, sessionIdAt(batchSize), 0))).toMatchObject({
      message: { content: [{ type: "text", text: "Migrating" }] },
    });
    expect(readRow(opened.path, "PRAGMA user_version")?.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "competitor",
      path: path.join(stateDir, "competitor.sqlite"),
      env,
    });
    releaseOpenClawAgentDatabaseLease(leaseId, { env });
  });
});
