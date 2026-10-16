import fs from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { createScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { AGENT_V14_CORE_SCHEMA_SQL } from "./openclaw-agent-schema-history.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

// Frozen v27 plus the three published v28 DDL changes; independent of candidate transforms.
const schemaV28 = fs
  .readFileSync(
    new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v27.sql", import.meta.url),
    "utf8",
  )
  .replace(
    "ON session_windows(primary_conversation_id, updated_at DESC, session_id)",
    "ON session_windows(primary_conversation_id)",
  )
  .replace(
    `CREATE INDEX IF NOT EXISTS idx_agent_transcript_event_parent
  ON transcript_event_identities(session_id, parent_id)
  WHERE parent_id IS NOT NULL;

`,
    "",
  )
  .replace(
    /(CREATE TABLE IF NOT EXISTS memory_entry_origins \([\s\S]*?\n\) STRICT);/u,
    "$1, WITHOUT ROWID;",
  );
const scope = [
  "schema_meta",
  "session_nodes",
  "session_reactions",
  "sqlite_stat1",
  "sqlite_stat4",
  "transcript_events",
];

function seed(database: DatabaseSync): void {
  database.exec(schemaV28);
  database.exec(`
    PRAGMA user_version = 28;
    PRAGMA foreign_keys = ON;
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
      VALUES ('primary', 'agent', 28, 'main', 1, 1);
    INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at, last_interaction_at)
      VALUES ('agent:main:test', 'session', '{"sessionId":"session","updatedAt":1}', 1, 10);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('session', 'agent:main:test', 1, 1);
    INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('session', 1, '{"type":"message","message":{"role":"user"}}', 1);
    INSERT INTO session_reactions
      (session_key, session_id, message_id, emoji, identity_id, identity_label, created_at)
      VALUES ('agent:main:test', 'session', 'message', '👍', 'alice', 'Alice', 1);
    INSERT INTO cache_entries (scope, key, blob, updated_at)
      VALUES ('unrelated', 'bytes', X'000100FF', 1);
    CREATE INDEX local_reaction_identity ON session_reactions(identity_id);
    ANALYZE;
  `);
}

function indexDefinitions(database: DatabaseSync) {
  return database
    .prepare(`SELECT name, sql FROM sqlite_schema
      WHERE tbl_name IN ('session_nodes', 'session_reactions') AND type = 'index'
      ORDER BY name`)
    .all();
}

function retained(database: DatabaseSync) {
  return {
    nodes: database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
    reactions: database.prepare("SELECT * FROM session_reactions ORDER BY identity_id").all(),
    events: database
      .prepare(`SELECT session_id, seq, event_json, created_at,
        event_zstd, event_utf8_bytes, navigation_json
        FROM transcript_events ORDER BY session_id, seq`)
      .all(),
  };
}

describe("agent index retirement migration", () => {
  it("retains the exact schema-28 admission contract", () => {
    expect(getOpenClawAgentMigrationSchema(28)).toBe(schemaV28);
  });

  it("keeps future model byte columns out of historical admission", () => {
    for (const schema of [AGENT_V14_CORE_SCHEMA_SQL, getOpenClawAgentMigrationSchema(24)]) {
      using database = new DatabaseSync(":memory:");
      database.exec(schema);
      const columns = database.prepare("PRAGMA table_info(transcript_events)").all();
      expect(columns.map(({ name }) => name)).not.toContain("model_bytes");
      expect(columns.map(({ name }) => name)).not.toContain("model_without_checkpoint_bytes");
    }
  });

  it.each(["commit", "rollback"] as const)(
    "preserves rows and publishes index removals and nullable model bytes atomically (%s)",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("index-retirement.sqlite");
        using database = new DatabaseSync(pathname);
        seed(database);
        const before = retained(database);
        const indexes = indexDefinitions(database);
        const transcriptColumns = database.prepare("PRAGMA table_info(transcript_events)").all();
        const captureWitness = () =>
          captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" });
        const originalWitness = captureWitness();
        if (outcome === "rollback") {
          database.setAuthorizer((action, name, value) =>
            action === constants.SQLITE_PRAGMA &&
            name === "user_version" &&
            value === String(OPENCLAW_AGENT_SCHEMA_VERSION)
              ? constants.SQLITE_DENY
              : constants.SQLITE_OK,
          );
        }
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          const migrate = () =>
            ensureOpenClawAgentDatabaseSchema(database, {
              agentId: "main",
              env: state.env,
              path: pathname,
            });
          await assertSqliteMigrationScopePreserved(database, scope, () => {
            if (outcome === "rollback") {
              expect(migrate).toThrow(/authoriz/u);
            } else {
              migrate();
            }
          });
        });
        database.setAuthorizer(null);
        expect(retained(database)).toEqual(before);
        const expectedVersion = outcome === "rollback" ? 28 : OPENCLAW_AGENT_SCHEMA_VERSION;
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(expectedVersion);
        expect(
          database.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
        ).toBe(expectedVersion);
        expect(assertOpenClawMigrationWitnessPreserved(originalWitness, captureWitness())).toEqual({
          warnings: [],
        });
        expect(indexDefinitions(database)).toEqual(
          outcome === "rollback"
            ? indexes
            : indexes.filter(
                ({ name }) =>
                  name !== "idx_agent_session_nodes_last_interaction_at" &&
                  name !== "idx_agent_session_reactions_message",
              ),
        );
        if (outcome === "rollback") {
          expect(database.prepare("PRAGMA table_info(transcript_events)").all()).toEqual(
            transcriptColumns,
          );
          return;
        }
        expect(
          database
            .prepare("PRAGMA table_info(transcript_events)")
            .all()
            .slice(transcriptColumns.length),
        ).toEqual([
          {
            cid: transcriptColumns.length,
            name: "model_bytes",
            type: "INTEGER",
            notnull: 0,
            dflt_value: null,
            pk: 0,
          },
          {
            cid: transcriptColumns.length + 1,
            name: "model_without_checkpoint_bytes",
            type: "INTEGER",
            notnull: 0,
            dflt_value: null,
            pk: 0,
          },
        ]);
        expect(
          database
            .prepare("SELECT model_bytes, model_without_checkpoint_bytes FROM transcript_events")
            .all(),
        ).toEqual([{ model_bytes: null, model_without_checkpoint_bytes: null }]);
        const currentWitness = captureWitness();
        // Migration normalization never permits unrelated index loss or same-version drift.
        database.exec("SAVEPOINT witness_drift; DROP INDEX local_reaction_identity");
        expect(() =>
          assertOpenClawMigrationWitnessPreserved(originalWitness, captureWitness()),
        ).toThrow(/changed or lost/u);
        database.exec("ROLLBACK TO witness_drift; RELEASE witness_drift");
        database.exec(`SAVEPOINT witness_drift;
          CREATE INDEX idx_agent_session_reactions_message
            ON session_reactions(session_key, session_id, message_id)`);
        expect(() =>
          assertOpenClawMigrationWitnessPreserved(currentWitness, captureWitness()),
        ).toThrow(/changed or lost/u);
        expect(() =>
          assertOpenClawMigrationWitnessPreserved(originalWitness, captureWitness()),
        ).toThrow(/changed or lost/u);
        database.exec("ROLLBACK TO witness_drift; RELEASE witness_drift");

        database.exec("SAVEPOINT witness_drift; UPDATE transcript_events SET model_bytes = 1");
        expect(() =>
          assertOpenClawMigrationWitnessPreserved(currentWitness, captureWitness()),
        ).toThrow(/changed or lost/u);
        database.exec("ROLLBACK TO witness_drift; RELEASE witness_drift");

        // The primary key still enforces uniqueness and serves current message reactions.
        database.exec(`
          UPDATE session_nodes SET last_interaction_at = 20 WHERE session_key = 'agent:main:test';
          INSERT INTO session_reactions
            (session_key, session_id, message_id, emoji, identity_id, created_at)
            VALUES ('agent:main:test', 'session', 'message', '👍', 'bob', 2);
          DELETE FROM session_reactions WHERE identity_id = 'alice';
        `);
        expect(
          database.prepare("SELECT last_interaction_at FROM session_nodes").get()
            ?.last_interaction_at,
        ).toBe(20);
        expect(
          database
            .prepare(`SELECT identity_id FROM session_reactions
            WHERE session_key = 'agent:main:test' AND session_id = 'session' AND message_id = 'message'`)
            .all(),
        ).toEqual([{ identity_id: "bob" }]);
        expect(() =>
          database.exec(`INSERT INTO session_reactions
            (session_key, session_id, message_id, emoji, identity_id, created_at)
            VALUES ('agent:main:test', 'session', 'message', '👍', 'bob', 3)`),
        ).toThrow(/UNIQUE/u);
        database.exec("DELETE FROM session_nodes WHERE session_key = 'agent:main:test'");
        expect(database.prepare("SELECT * FROM session_reactions").all()).toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      });
    },
  );

  it("restores scoped columns, indexes and rows without overwriting later unrelated writes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.statePath("index-retirement-restore.sqlite");
      const backupPath = state.statePath("index-retirement.scoped.bak");
      using database = new DatabaseSync(pathname);
      seed(database);
      const before = retained(database);
      const indexes = indexDefinitions(database);
      const transcriptColumns = database.prepare("PRAGMA table_info(transcript_events)").all();
      const statistics = database.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx").all();
      expect(
        resolveSchemaMigrationBackupTables({
          kind: "agent",
          foundVersion: 28,
          supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        }),
      ).toEqual(scope);
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
        await createScopedMigrationSnapshot({
          sourcePath: pathname,
          targetPath: backupPath,
          tables: scope,
          beforePublish: () => lease.assertOwned(),
        });
        ensureOpenClawAgentDatabaseSchema(database, {
          agentId: "main",
          env: state.env,
          path: pathname,
        });
      });
      database.exec("UPDATE cache_entries SET blob = X'BEEF' WHERE scope = 'unrelated'");
      database.exec(
        "UPDATE transcript_events SET model_bytes = 123, model_without_checkpoint_bytes = 123",
      );
      await assertSqliteMigrationScopePreserved(database, scope, () =>
        restoreDoctorMigrationBackup({ sourcePath: pathname, backupPath, env: state.env }),
      );
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(28);
      expect(retained(database)).toEqual(before);
      expect(database.prepare("PRAGMA table_info(transcript_events)").all()).toEqual(
        transcriptColumns,
      );
      expect(indexDefinitions(database)).toEqual(indexes);
      expect(database.prepare("SELECT * FROM sqlite_stat1 ORDER BY tbl, idx").all()).toEqual(
        statistics,
      );
      expect(database.prepare("SELECT hex(blob) AS bytes FROM cache_entries").get()?.bytes).toBe(
        "BEEF",
      );
    });
  });
});
