import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { repairLegacySubagentRetainedResults } from "./openclaw-state-db-legacy-backfills.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  prepareOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "./openclaw-state-schema-v17.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

describe("Doctor historical row repair", () => {
  it("refuses an automatic older-schema upgrade with invalid foreign keys without repairing rows", async () => {
    const stateDir = tempDirs.make("openclaw-automatic-upgrade-integrity-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { db: initial, path: pathname } = openOpenClawStateDatabase(options);
    initial.exec("PRAGMA foreign_keys = OFF;");
    initial
      .prepare("INSERT INTO task_delivery_state (task_id, requester_origin_json) VALUES (?, ?)")
      .run("missing-task", '{"channel":"synthetic"}');
    removePreparedWorkerOwnershipColumns(initial);
    initial.exec("PRAGMA user_version = 16; UPDATE schema_meta SET schema_version = 16;");
    closeOpenClawStateDatabaseForTest();

    expect(await prepareOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [expect.stringMatching(/foreign_key_check failed.*task_delivery_state/iu)],
    });
    const preserved = new DatabaseSync(pathname, { readOnly: true });
    try {
      expect(preserved.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
      expect(
        preserved.prepare("SELECT task_id, requester_origin_json FROM task_delivery_state").all(),
      ).toEqual([{ task_id: "missing-task", requester_origin_json: '{"channel":"synthetic"}' }]);
      expect(
        preserved
          .prepare("PRAGMA table_info(worker_environments)")
          .all()
          .map((row) => row.name),
      ).not.toContain("preparation_key");
    } finally {
      preserved.close();
    }
  });
});

describe("repairLegacySubagentRetainedResults", () => {
  it("promotes shipped payload results without a Task projection and is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE subagent_runs (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        pending_final_delivery_payload_json TEXT
      ) STRICT;
    `);
    const legacyPayload = {
      frozenResultText: "(no_reply)",
      fallbackFrozenResultText: "findings captured before wake",
      requesterSessionKey: "agent:main:main",
    };
    db.prepare(
      `INSERT INTO subagent_runs (
        run_id, payload_json, pending_final_delivery_payload_json
      ) VALUES (?, ?, ?)`,
    ).run(
      "completion-run",
      JSON.stringify({
        runId: "completion-run",
        taskRunId: " task-run ",
        completion: { required: true, resultText: "(no_reply)" },
        delivery: {
          status: "suspended",
          payload: {
            frozenResultText: "(no_reply)",
            requesterSessionKey: "agent:main:main",
          },
        },
      }),
      JSON.stringify(legacyPayload),
    );

    repairLegacySubagentRetainedResults(db);
    const firstPass = db
      .prepare(
        `SELECT payload_json, pending_final_delivery_payload_json
           FROM subagent_runs WHERE run_id = ?`,
      )
      .get("completion-run") as {
      payload_json: string;
      pending_final_delivery_payload_json: string;
    };
    repairLegacySubagentRetainedResults(db);
    const secondPass = db
      .prepare(
        `SELECT payload_json, pending_final_delivery_payload_json
           FROM subagent_runs WHERE run_id = ?`,
      )
      .get("completion-run");

    expect(secondPass).toEqual(firstPass);
    const payload = JSON.parse(firstPass.payload_json);
    expect(payload.completion).toEqual({
      required: true,
      resultText: "(no_reply)",
      fallbackResultText: "findings captured before wake",
    });
    expect(payload.delivery.payload).toEqual({ requesterSessionKey: "agent:main:main" });
    expect(JSON.parse(firstPass.pending_final_delivery_payload_json)).toEqual(legacyPayload);
  });

  it("preserves authoritative terminal silence while promoting legacy results", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE subagent_runs (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      ) STRICT;
    `);
    const legacyPayload = {
      frozenResultText: "NO_REPLY",
      fallbackFrozenResultText: "older visible fallback",
    };
    db.prepare("INSERT INTO subagent_runs (run_id, payload_json) VALUES (?, ?)").run(
      "silent-run",
      JSON.stringify({
        taskRunId: "silent-task-run",
        completion: {
          required: true,
          resultText: "NO_REPLY",
          terminalReply: { disposition: "silent" },
        },
        delivery: { status: "suspended", payload: legacyPayload },
      }),
    );

    repairLegacySubagentRetainedResults(db);

    const stored = db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get("silent-run") as { payload_json: string };
    expect(JSON.parse(stored.payload_json).completion).toEqual({
      required: true,
      resultText: "NO_REPLY",
      fallbackResultText: "older visible fallback",
      terminalReply: { disposition: "silent" },
    });
  });
});
