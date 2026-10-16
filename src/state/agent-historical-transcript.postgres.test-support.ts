import assert from "node:assert/strict";
import type { Client } from "pg";

export async function restoreHistoricalTranscriptTable(
  client: Client,
  namespace: string,
  postgres: string,
) {
  const declaration = postgres.match(/CREATE TABLE "transcript_events" \([\s\S]*?\n\);/)?.[0];
  assert(declaration);
  const columns = [...declaration.matchAll(/^ {2}("[^"]+") /gm)]
    .map((match) => match[1])
    .join(", ");
  const foreignKeys = (postgres.match(/ALTER TABLE "[^"]+" ADD FOREIGN KEY [^;]+;/g) ?? [])
    .filter((sql) => sql.includes('"transcript_events"'))
    .join("\n");
  // DROP COLUMN retains PostgreSQL attnum holes, unlike a real historical table.
  // Recreate its exact generated declaration while preserving owner-written rows.
  await client.query(`BEGIN;
    SET LOCAL search_path TO "${namespace.replaceAll('"', '""')}";
    CREATE TEMP TABLE historical_transcript_rows ON COMMIT DROP AS
      SELECT ${columns} FROM transcript_events;
    DROP TABLE transcript_events CASCADE;
    ${declaration}
    INSERT INTO transcript_events (${columns}) SELECT ${columns} FROM historical_transcript_rows;
    ${foreignKeys}
    COMMIT;`);
}
