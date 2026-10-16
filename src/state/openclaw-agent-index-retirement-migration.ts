/** Historical admission retains the exact indexes installed before v29. */
export function withLegacyAgentIndexes(schema: string): string {
  return schema
    .replace(
      "CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_label",
      `CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_last_interaction_at
  ON session_nodes(last_interaction_at DESC, session_key);

CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_label`,
    )
    .replace(
      "CREATE TABLE IF NOT EXISTS board_tabs (",
      `CREATE INDEX IF NOT EXISTS idx_agent_session_reactions_message
  ON session_reactions(session_key, session_id, message_id);

CREATE TABLE IF NOT EXISTS board_tabs (`,
    );
}

export function withLegacyAgentPostgresIndexes(schema: string): string {
  return `${schema}
    CREATE INDEX "idx_agent_session_nodes_last_interaction_at"
      ON "session_nodes" (("last_interaction_at") DESC NULLS LAST,
        ("session_key") ASC NULLS FIRST);
    CREATE INDEX "idx_agent_session_reactions_message"
      ON "session_reactions" (("session_key") ASC NULLS FIRST,
        ("session_id") ASC NULLS FIRST, ("message_id") ASC NULLS FIRST);
  `;
}

export const AGENT_INDEX_RETIREMENT_SQL = `
  DROP INDEX IF EXISTS idx_agent_session_nodes_last_interaction_at;
  DROP INDEX IF EXISTS idx_agent_session_reactions_message;
`;
