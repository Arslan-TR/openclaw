import { sql } from "kysely";
import { expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { copySqliteSessionGenerationRows } from "./session-accessor.sqlite-generation-copy.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { transcriptEventJsonSql, transcriptEventModelBytesSql } from "./transcript-payload.js";

it("treats a streaming copy onto its source as a no-op without deleting any rows", async () => {
  await withOpenClawTestState({ label: "generation-self-copy" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:copy",
      sessionId: "copy",
    };
    runOpenClawAgentWriteTransaction(
      (database) => {
        appendTranscriptEventsInTransaction(database, scope, [
          { type: "session", version: 3, id: scope.sessionId },
          {
            type: "message",
            id: "message",
            parentId: null,
            message: { role: "user", content: "Preserve these exact bytes." },
          },
        ]);
        const snapshot = () => ({
          events: database.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all(),
          identities: database.db
            .prepare("SELECT * FROM transcript_event_identities ORDER BY event_id")
            .all(),
        });
        const before = snapshot();
        expect(before.events).toHaveLength(2);
        expect(() =>
          copySqliteSessionGenerationRows({
            destination: database,
            source: database,
            sessionId: scope.sessionId,
            sourceWindowPresent: true,
          }),
        ).not.toThrow();
        expect(snapshot()).toEqual(before);
      },
      { agentId: scope.agentId, env: scope.env },
    );
  });
});

it.each([
  { sourceEncoding: "UTF-8", destinationEncoding: "UTF-8" },
  { sourceEncoding: "UTF-8", destinationEncoding: "UTF-16le" },
  { sourceEncoding: "UTF-16le", destinationEncoding: "UTF-8" },
])(
  "retains exact model byte budgets when copying $sourceEncoding to $destinationEncoding",
  async ({ sourceEncoding, destinationEncoding }) => {
    await withOpenClawTestState({ label: "generation-byte-copy" }, async (state) => {
      const sourceOptions = { agentId: "main", env: state.env, path: state.path("source.sqlite") };
      const destinationOptions = {
        agentId: "main",
        env: state.env,
        path: state.path("destination.sqlite"),
      };
      for (const [options, encoding] of [
        [sourceOptions, sourceEncoding],
        [destinationOptions, destinationEncoding],
      ] as const) {
        using seed = openNodeSqliteDatabase(options.path);
        seed.exec(`PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER);
          DROP TABLE encoding_seed;`);
      }
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:copy",
        sessionId: "copy",
      };
      const header = { type: "session", version: 3, id: scope.sessionId };
      const message = { role: "user", content: "Preserve café 日本語 🦞. ".repeat(200) };
      const eventFields = { type: "message", id: "message", parentId: null };
      const event = {
        ...eventFields,
        message: { ...message, providerReplay: { type: "checkpoint", data: "retained replay" } },
      };
      const headerJson = JSON.stringify(header);
      const eventJson = JSON.stringify(event);
      const withoutCheckpoint = JSON.stringify({ ...eventFields, message });
      runOpenClawAgentWriteTransaction((source) => {
        appendTranscriptEventsInTransaction(source, scope, [header, event]);
        source.db
          .prepare(`UPDATE transcript_events SET model_bytes = NULL,
            model_without_checkpoint_bytes = NULL WHERE seq = 0`)
          .run();
      }, sourceOptions);
      const source = openOpenClawAgentDatabase(sourceOptions);
      runOpenClawAgentWriteTransaction((destination) => {
        appendTranscriptEventsInTransaction(destination, scope, [header]);
        copySqliteSessionGenerationRows({
          destination,
          source,
          sessionId: scope.sessionId,
          sourceWindowPresent: true,
        });
        const rows = executeSqliteQuerySync(
          destination.db,
          getNodeSqliteKysely<DB>(destination.db)
            .selectFrom("transcript_events")
            .select([
              transcriptEventJsonSql(destination.db).as("event_json"),
              "model_bytes",
              "model_without_checkpoint_bytes",
              transcriptEventModelBytesSql(destination.db, sql.lit(0)).as("effective_bytes"),
              transcriptEventModelBytesSql(destination.db, sql.lit(1)).as("without_checkpoint"),
            ])
            .orderBy("seq"),
        ).rows;
        const encoding = destinationEncoding === "UTF-8" ? "utf8" : "utf16le";
        const copiedBytes = Buffer.byteLength(eventJson, encoding);
        const copiedWithoutCheckpoint = Buffer.byteLength(withoutCheckpoint, encoding);
        expect(rows).toEqual([
          {
            event_json: headerJson,
            model_bytes: null,
            model_without_checkpoint_bytes: null,
            effective_bytes: Buffer.byteLength(headerJson, encoding),
            without_checkpoint: Buffer.byteLength(headerJson, encoding),
          },
          {
            event_json: eventJson,
            model_bytes: sourceEncoding === destinationEncoding ? copiedBytes : null,
            model_without_checkpoint_bytes:
              sourceEncoding === destinationEncoding ? copiedWithoutCheckpoint : null,
            effective_bytes: copiedBytes,
            without_checkpoint: copiedWithoutCheckpoint,
          },
        ]);
      }, destinationOptions);
    });
  },
);
