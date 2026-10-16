import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { withAgentDatabaseCloseFence } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  readConversation,
  resolveCurrentSessionPrimaryConversation,
  withConversationAuthority,
} from "./conversation-registry.js";
import {
  commitReplySessionInitialization,
  deleteSessionEntryLifecycle,
  loadReplySessionInitializationSnapshot,
  upsertSessionEntryCore as upsertCanonicalSessionEntry,
} from "./session-accessor.js";
import {
  conversationPublication,
  type ConversationPublication,
} from "./session-accessor.sqlite-conversation-publication.js";
import {
  linkSessionConversation,
  prepareConversationIdentities,
  upsertConversationIdentities,
} from "./session-accessor.sqlite-conversation.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

type LegacyDeliveryFixture = Partial<SessionEntry> & {
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
};

const upsertSessionEntry = (
  scope: Parameters<typeof upsertCanonicalSessionEntry>[0],
  entry: LegacyDeliveryFixture,
) => upsertCanonicalSessionEntry(scope, normalizeLegacySessionEntryDelivery(entry as SessionEntry));

describe("conversation registry", () => {
  let tempDir: string;
  let storePath: string;

  const registryScope = () => ({ agentId: "main", storePath });
  const sessionScope = (sessionKey: string) => ({ ...registryScope(), sessionKey });
  const read = (ref: string) => readConversation(registryScope(), ref);
  const primary = (
    scope: Parameters<typeof resolveCurrentSessionPrimaryConversation>[0],
    sessionId: string,
  ) => resolveCurrentSessionPrimaryConversation({ ...scope, sessionId });
  const routedEntry = (
    sessionId: string,
    to: string,
    channel = "reef",
    updatedAt = 100,
  ): LegacyDeliveryFixture => ({
    sessionId,
    updatedAt,
    chatType: channel === "reef" ? "direct" : "channel",
    deliveryContext: { channel, accountId: "default", to },
  });
  const address = (
    peerId: string,
    deliveryTarget: string,
    options: Partial<Parameters<typeof buildConversationIdentity>[0]> = {},
  ) =>
    buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId,
      deliveryTarget,
      ...options,
    });
  function commitInitialization(
    scope: { agentId: string; sessionKey: string; storePath: string },
    snapshot: Awaited<ReturnType<typeof loadReplySessionInitializationSnapshot>>,
    options: Partial<
      Pick<Parameters<typeof commitReplySessionInitialization>[0], "routeContext" | "sessionEntry">
    > = {},
  ) {
    return commitReplySessionInitialization({
      ...scope,
      activeSessionKey: scope.sessionKey,
      expectedRevision: snapshot.revision,
      snapshotEntry: snapshot.currentEntry,
      sessionEntry: snapshot.currentEntry!,
      ...options,
    });
  }
  const openDatabase = (scope: Parameters<typeof resolveSqliteReadScope>[0]) =>
    openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
  const tempDirs = createTempDirTracker();
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
      closeOpenClawAgentDatabasesForTest(dir);
    }
    tempDirs.cleanup();
  });

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-conversations-");
    storePath = path.join(tempDir, "sessions.json");
  });

  it("catalogs a directory address without inventing a model-context session", async () => {
    const identity = address("reef:peer-a", "reef:peer-a", {
      nativeDirectUserId: "peer-a",
      label: "@peer-a's agent",
    });
    expect(identity).toBeDefined();
    const receipts: ConversationPublication[] = [];
    const unsubscribe = conversationPublication.subscribe((receipt) => receipts.push(receipt));
    try {
      await registerConversationAddresses(registryScope(), [identity!], 100);
    } finally {
      unsubscribe();
    }
    expect(receipts).toHaveLength(1);
    expect(
      receipts[0]?.facts.get(JSON.stringify(["catalogue", identity!.conversationRef])),
    ).toMatchObject({
      kind: "postimage",
      value: {
        kind: "catalogue",
        row: {
          conversation_id: identity!.conversationRef,
          label: identity!.label,
          created_at: 100,
          updated_at: 100,
        },
      },
    });

    const [conversation] = await listConversations(registryScope(), { channel: "reef" });
    expect(conversation).toMatchObject({
      conversationRef: identity?.conversationRef,
      target: "reef:peer-a",
      label: "@peer-a's agent",
      firstSeenAt: 100,
      lastSeenAt: 100,
    });
    expect(conversation?.sessionId).toBeUndefined();
    expect(conversation?.sessionKey).toBeUndefined();
    expect(conversation?.role).toBeUndefined();
    expect(await read(identity!.conversationRef)).toEqual(conversation);

    const second = address("peer-b", "reef:peer-b");
    const label = "last\u0000literal\\u0000";
    await registerConversationAddresses(
      registryScope(),
      [identity!, second!, { ...identity!, label, nativeDirectUserId: undefined }],
      200,
    );
    const updated = await read(identity!.conversationRef);
    expect(updated).toMatchObject({ label, firstSeenAt: 100, lastSeenAt: 200 });
    expect(updated?.nativeDirectUserId).toBeUndefined();
    expect(await read(second!.conversationRef)).toMatchObject({
      target: "reef:peer-b",
      firstSeenAt: 200,
      lastSeenAt: 200,
    });
  });

  it.each(["registration", "authority"] as const)(
    "releases %s resources when a queued database target is replaced",
    async (operation) => {
      const databasePath = path.join(tempDir, "registry.sqlite");
      fs.writeFileSync(databasePath, "");
      const scope = {
        agentId: "main",
        databaseAgentId: "main",
        storePath: databasePath,
        env: { OPENCLAW_STATE_DIR: tempDir },
      };
      const entered = createDeferred();
      const release = createDeferred();
      const held = runOpenClawAgentWorkerWrite(
        { agentId: "main", path: databasePath, env: scope.env },
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      let pending: Promise<unknown> | undefined;
      try {
        await awaitGateBeforeSettlement(entered.promise, held, "Writer did not acquire its lane");
        const identity = buildConversationIdentity({
          channel: "reef",
          kind: "direct",
          peerId: "peer-a",
          deliveryTarget: "reef:peer-a",
        });
        expect(identity).not.toBeNull();
        pending =
          operation === "registration"
            ? registerConversationAddresses(scope, [identity!])
            : withConversationAuthority(
                scope,
                { conversationRef: identity!.conversationRef },
                () => {
                  throw new Error("A replaced target must not grant conversation authority");
                },
              );
        const rejected = expect(pending).rejects.toThrow(
          "Agent database target changed before write admission",
        );
        fs.renameSync(databasePath, `${databasePath}.previous`);
        fs.writeFileSync(databasePath, "");
        release.resolve();
        await rejected;
        await held;
        await withAgentDatabaseCloseFence({ path: databasePath }, async (resources) => {
          expect(resources).toEqual([]);
        });
      } finally {
        release.resolve();
        await Promise.allSettled([held, pending]);
      }
    },
  );

  it("rejects an empty conversation reference instead of widening the lookup", async () => {
    const identity = address("reef:peer-b", "reef:peer-b", {
      nativeDirectUserId: "peer-b",
      label: "@peer-b's agent",
    });
    await registerConversationAddresses(registryScope(), [identity!], 100);

    for (const conversationRef of ["", "   "]) {
      await expect(read(conversationRef)).rejects.toThrow(/Invalid conversationRef/);
    }
  });

  it("round-trips authoritative route context on its conversation association", async () => {
    const sessionKey = "agent:main:discord:channel:ops";
    const scope = sessionScope(sessionKey);
    await upsertSessionEntry(scope, routedEntry("ops-session", "channel:ops", "discord"));
    const snapshot = await loadReplySessionInitializationSnapshot(scope);

    const committed = await commitInitialization(scope, snapshot, {
      routeContext: {
        peerId: "canonical-ops",
        guildId: "guild-a",
        parentPeerId: "parent-a",
        memberRoleIds: ["support", "admin"],
      },
    });

    expect(committed.ok).toBe(true);
    const canonicalConversation = (await listConversations(scope)).find(
      (conversation) => conversation.peerId === "canonical-ops",
    );
    expect(canonicalConversation).toBeDefined();
    const conversationRef = canonicalConversation!.conversationRef;
    expect(await primary(scope, "ops-session")).toEqual(canonicalConversation);
    expect(await primary(scope, "another-session")).toBeUndefined();
    expect(
      await resolveCurrentSessionPrimaryConversation({
        ...scope,
        sessionId: "ops-session",
        sessionKey: "agent:main:discord:channel:another",
      }),
    ).toBeUndefined();
    expect(await read(conversationRef)).toMatchObject({
      peerId: "canonical-ops",
      observedFromSession: true,
      routeContextObserved: true,
      routeContext: {
        peerId: "canonical-ops",
        guildId: "guild-a",
        parentPeerId: "parent-a",
        memberRoleIds: ["admin", "support"],
      },
    });

    const resumedSnapshot = await loadReplySessionInitializationSnapshot(scope);
    expect(
      await commitInitialization(scope, resumedSnapshot, {
        sessionEntry: {
          ...resumedSnapshot.currentEntry!,
          updatedAt: canonicalConversation!.lastSeenAt + 100,
        },
      }),
    ).toMatchObject({ ok: true });
    const resumed = await readConversation(scope, conversationRef);
    expect(resumed!.lastSeenAt).toBeGreaterThan(canonicalConversation!.lastSeenAt);
    expect(resumed).toEqual({ ...canonicalConversation, lastSeenAt: resumed!.lastSeenAt });

    await upsertCanonicalSessionEntry(scope, {
      totalTokens: 42,
      updatedAt: resumed!.lastSeenAt + 100,
    });
    expect(await readConversation(scope, conversationRef)).toEqual(resumed);
    expect(await primary(scope, "ops-session")).toEqual(resumed);

    const observedSnapshot = await loadReplySessionInitializationSnapshot(scope);
    expect(
      await commitInitialization(scope, observedSnapshot, {
        routeContext: { peerId: "canonical-ops", guildId: "guild-b" },
      }),
    ).toMatchObject({ ok: true });
    const observed = await readConversation(scope, conversationRef);
    expect(observed).toMatchObject({ routeContext: { guildId: "guild-b" } });
    expect(observed!.lastSeenAt).toBeGreaterThan(resumed!.lastSeenAt);

    await upsertCanonicalSessionEntry(scope, { label: "generic current write", updatedAt: 200 });
    expect(
      (await listConversations(scope)).filter((conversation) => conversation.role === "primary"),
    ).toEqual([expect.objectContaining({ conversationRef, peerId: "canonical-ops" })]);
    const afterCurrentWrite = await read(conversationRef);
    expect(afterCurrentWrite).toMatchObject({
      label: "generic current write",
      routeContextObserved: true,
      routeContext: { guildId: "guild-b" },
    });

    await closeOpenClawAgentDatabasesAsync(tempDir);
    const database = openDatabase(scope);
    database.db
      .prepare(
        `INSERT INTO session_conversations (
          session_id, conversation_id, role, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, conversation_id, role) DO UPDATE SET
          last_seen_at = excluded.last_seen_at`,
      )
      .run(
        "ops-session",
        conversationRef,
        "primary",
        afterCurrentWrite!.firstSeenAt,
        afterCurrentWrite!.lastSeenAt,
      );
    await closeOpenClawAgentDatabasesAsync(tempDir);
    closeOpenClawAgentDatabasesForTest();

    expect(await read(conversationRef)).not.toMatchObject({
      routeContextObserved: true,
    });
    expect((await primary(scope, "ops-session"))?.routeContext).toBeUndefined();
    await upsertCanonicalSessionEntry(scope, {
      label: "after older writer",
      updatedAt: afterCurrentWrite!.lastSeenAt + 1,
    });
    expect(await read(conversationRef)).not.toMatchObject({
      routeContextObserved: true,
    });
  });

  it("keeps route context with each conversation when a shared session changes primary", async () => {
    const sessionKey = "agent:main:discord:channel:shared";
    const scope = sessionScope(sessionKey);
    const writeRoute = async (target: string, guildId: string, updatedAt: number) => {
      await upsertSessionEntry(scope, routedEntry("shared-session", target, "discord", updatedAt));
      const snapshot = await loadReplySessionInitializationSnapshot(scope);
      const committed = await commitInitialization(scope, snapshot, {
        routeContext: { guildId },
      });
      expect(committed.ok).toBe(true);
    };

    await writeRoute("channel:alpha", "guild-alpha", 100);
    await writeRoute("channel:beta", "guild-beta", 200);
    await writeRoute("channel:alpha", "guild-alpha", 300);
    await writeRoute("channel:beta", "guild-beta", 400);

    expect(
      (await listConversations(scope, { channel: "discord" }))
        .map(({ target, routeContext }) => ({ target, routeContext }))
        .toSorted((left, right) => left.target.localeCompare(right.target)),
    ).toEqual([
      { target: "channel:alpha", routeContext: { guildId: "guild-alpha" } },
      { target: "channel:beta", routeContext: { guildId: "guild-beta" } },
    ]);
    await closeOpenClawAgentDatabasesAsync(tempDir);
    const database = openDatabase(scope);
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_conversations")
        .set({ last_seen_at: 500 })
        .where("session_id", "=", "shared-session")
        .where("role", "=", "related"),
    );
    expect(await primary(scope, "shared-session")).toMatchObject({
      target: "channel:beta",
      routeContext: { guildId: "guild-beta" },
    });
  });

  it("preserves context across an unobserved rollover and clears it on observed-empty ingress", async () => {
    const sessionKey = "agent:main:discord:channel:rollover";
    const scope = sessionScope(sessionKey);
    await upsertSessionEntry(scope, routedEntry("before-rollover", "channel:rollover", "discord"));
    let snapshot = await loadReplySessionInitializationSnapshot(scope);
    await commitInitialization(scope, snapshot, {
      routeContext: { guildId: "guild-a", memberRoleIds: ["support"] },
    });

    snapshot = await loadReplySessionInitializationSnapshot(scope);
    const rollover = await commitInitialization(scope, snapshot, {
      sessionEntry: { ...snapshot.currentEntry!, sessionId: "after-rollover", updatedAt: 200 },
    });
    expect(rollover.ok).toBe(true);
    expect((await listConversations(scope))[0]).toMatchObject({
      sessionId: "after-rollover",
      routeContextObserved: true,
      routeContext: { guildId: "guild-a", memberRoleIds: ["support"] },
    });
    expect(await primary(scope, "before-rollover")).toBeUndefined();
    expect(await primary(scope, "after-rollover")).toMatchObject({
      routeContext: { guildId: "guild-a" },
    });

    snapshot = await loadReplySessionInitializationSnapshot(scope);
    await commitInitialization(scope, snapshot, {
      routeContext: null,
    });
    expect((await listConversations(scope))[0]).toMatchObject({
      sessionId: "after-rollover",
      routeContextObserved: true,
    });
    expect((await listConversations(scope))[0]?.routeContext).toBeUndefined();
    expect((await primary(scope, "after-rollover"))?.routeContext).toBeUndefined();
  });

  it.each([
    { entry_valid: 0 },
    { entry_json: JSON.stringify({ sessionId: "wrong-session", updatedAt: 100 }) },
  ])("does not bind an invalid current entry to its primary address: %j", async (invalid) => {
    const scope = sessionScope("agent:main:reef:direct:peer-a");
    await upsertSessionEntry(scope, routedEntry("peer-a-session", "reef:peer-a"));
    await closeOpenClawAgentDatabasesAsync(tempDir);
    const database = openDatabase(scope);
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_nodes")
        .set(invalid)
        .where("session_key", "=", scope.sessionKey),
    );
    expect(await primary(scope, "peer-a-session")).toBeUndefined();
    if (invalid.entry_json !== undefined) {
      const [conversation] = await listConversations(scope);
      expect(conversation).toMatchObject({ target: "reef:peer-a" });
      expect(conversation?.sessionId).toBeUndefined();
      expect(conversation?.sessionKey).toBeUndefined();
    }
  });

  it("orders fresh directory addresses with session-backed conversation activity", async () => {
    await upsertSessionEntry(
      sessionScope("agent:main:reef:direct:peer-a"),
      routedEntry("peer-a-session", "reef:peer-a"),
    );
    const freshIdentity = address("reef:peer-b", "reef:peer-b");
    expect(freshIdentity).toBeDefined();
    const freshAt = Date.now() + 1_000;
    await registerConversationAddresses(registryScope(), [freshIdentity!], freshAt);

    expect(await listConversations(registryScope(), { channel: "reef", limit: 1 })).toEqual([
      expect.objectContaining({
        conversationRef: freshIdentity?.conversationRef,
        target: "reef:peer-b",
        lastSeenAt: freshAt,
      }),
    ]);
  });

  it("keeps a live binding when newer historical activity has no current entry", async () => {
    const liveSessionKey = "agent:main:reef:direct:peer-a-live";
    const staleSessionKey = "agent:main:reef:direct:peer-a-stale";
    for (const [sessionKey, sessionId] of [
      [liveSessionKey, "live-session"],
      [staleSessionKey, "stale-session"],
    ] as const) {
      await upsertSessionEntry(sessionScope(sessionKey), routedEntry(sessionId, "reef:peer-a"));
    }
    await closeOpenClawAgentDatabasesAsync(tempDir);
    const database = openDatabase(registryScope());
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_conversations")
        .set({ last_seen_at: 100 })
        .where("session_id", "=", "live-session"),
    );
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_conversations")
        .set({ last_seen_at: 200 })
        .where("session_id", "=", "stale-session"),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", staleSessionKey),
    );

    expect(
      (await listConversations(registryScope(), { channel: "reef", limit: 1 }))[0],
    ).toMatchObject({
      target: "reef:peer-a",
      sessionId: "live-session",
      sessionKey: liveSessionKey,
      lastSeenAt: 100,
    });
  });

  it("retains a deleted session's address without exposing a stale binding", async () => {
    const sessionKey = "agent:main:reef:direct:peer-a";
    const scope = sessionScope(sessionKey);
    await upsertSessionEntry(scope, routedEntry("deleted-session", "reef:peer-a"));
    const [linked] = await listConversations(registryScope(), { channel: "reef" });
    expect(linked?.sessionId).toBe("deleted-session");

    await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
    });
    expect(await primary(scope, "deleted-session")).toBeUndefined();

    expect(await read(linked?.conversationRef ?? "missing")).toMatchObject({
      conversationRef: linked?.conversationRef,
      target: "reef:peer-a",
    });
    expect(await read(linked?.conversationRef ?? "missing")).not.toMatchObject({
      sessionId: expect.any(String),
      sessionKey: expect.any(String),
    });
  });

  it("publishes native association role removals atomically and drops rolled-back catalogue changes", async () => {
    const scope = sessionScope("agent:main:receipt");
    const sessionId = "receipt-session";
    await upsertSessionEntry(scope, { sessionId, updatedAt: 1 });
    const options = toDatabaseOptions(resolveSqliteReadScope(scope));
    const identities = ["first", "second"].map((peerId) =>
      buildConversationIdentity({
        channel: "fixture",
        accountId: "default",
        kind: "channel",
        peerId,
        deliveryTarget: peerId,
      })!,
    );
    const write = (index: number, updatedAt: number, routeContext?: { guildId: string }) =>
      runOpenClawAgentWriteTransaction((database) => {
        const identity = identities[index]!;
        upsertConversationIdentities(
          database,
          prepareConversationIdentities([identity]),
          updatedAt,
        );
        linkSessionConversation({
          database,
          sessionId,
          conversation: { identity, role: "primary", routeContext },
          updatedAt,
        });
      }, options);
    write(0, 10);
    const installed = new Map<string, unknown>();
    const snapshots: string[][] = [];
    const receipts: ConversationPublication[] = [];
    const unsubscribeFacts = conversationPublication.subscribeFacts((receipt) => {
      if (!("facts" in receipt)) {
        return;
      }
      for (const [key, fact] of receipt.facts) {
        installed.set(key, fact);
      }
    });
    const unsubscribe = conversationPublication.subscribe((receipt) => {
      receipts.push(receipt);
      snapshots.push([...installed.keys()].toSorted());
    });
    try {
      const database = openOpenClawAgentDatabase(options);
      const associationReads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["route"],
        (sql) =>
          sql.startsWith('select "last_seen_at", "route_context_json" from "session_conversations"')
            ? "route"
            : null,
      );
      try {
        write(1, 20, { guildId: "receipt-guild" });
        expect(associationReads.counts.route).toBe(0);
      } finally {
        associationReads.restore();
      }
      expect(await readConversation(scope, identities[1]!.conversationRef)).toMatchObject({
        routeContext: { guildId: "receipt-guild" },
      });
      const associationKey = (index: number, role: string) =>
        JSON.stringify(["association", sessionId, identities[index]!.conversationRef, role]);
      const oldPrimary = associationKey(0, "primary");
      const oldRelated = associationKey(0, "related");
      const newPrimary = associationKey(1, "primary");
      expect(installed.get(oldPrimary)).toEqual({ kind: "absent" });
      expect(installed.get(oldRelated)).toMatchObject({
        kind: "postimage",
        value: { row: { role: "related", first_seen_at: 10, last_seen_at: 20 } },
      });
      expect(installed.get(newPrimary)).toMatchObject({
        kind: "postimage",
        value: { row: { role: "primary", first_seen_at: 20, last_seen_at: 20 } },
      });
      expect(snapshots).toHaveLength(2);
      expect(
        snapshots.every(
          (keys) =>
            keys.includes(oldPrimary) && keys.includes(oldRelated) && keys.includes(newPrimary),
        ),
      ).toBe(true);
      expect(() =>
        runOpenClawAgentWriteTransaction(() => {
          write(0, 30);
          throw new Error("rollback conversation");
        }, options),
      ).toThrow("rollback conversation");
      expect(receipts).toHaveLength(2);
      expect(
        openOpenClawAgentDatabase(options)
          .db.prepare(
            "SELECT role FROM session_conversations WHERE session_id = ? AND conversation_id = ?",
          )
          .get(sessionId, identities[1]!.conversationRef),
      ).toEqual({ role: "primary" });
    } finally {
      unsubscribeFacts();
      unsubscribe();
    }
  });

  it("commits catalogue metadata whose encoded receipt exceeds the transport limit", async () => {
    const scope = registryScope();
    const identity = buildConversationIdentity({
      channel: "fixture",
      accountId: "default",
      kind: "direct",
      peerId: "large-catalogue",
      deliveryTarget: "large-catalogue",
    })!;
    // The request fits IPC; JSON's six-byte escape expands the stored postimage beyond it.
    identity.metadata = {
      payload: "\0".repeat(Math.floor(SQLITE_WORKER_MAX_MESSAGE_BYTES / 6) + 1),
    };
    const events: string[] = [];
    const unsubscribe = conversationPublication.subscribeFacts((change) => {
      if ("kind" in change) {
        events.push(change.kind);
      }
    });
    try {
      const outcome = await registerConversationAddresses(scope, [identity], 100).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      events.push("reply");
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
      expect(
        database.db
          .prepare(
            "SELECT length(metadata_json) AS bytes, updated_at FROM conversations WHERE conversation_id = ?",
          )
          .get(identity.conversationRef),
      ).toEqual({
        bytes: JSON.stringify(identity.metadata).length,
        updated_at: 100,
      });
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toBeUndefined();
      expect(events).toContain("unknown");
      expect(events.indexOf("unknown")).toBeLessThan(events.indexOf("reply"));
    } finally {
      unsubscribe();
    }
  });
});
