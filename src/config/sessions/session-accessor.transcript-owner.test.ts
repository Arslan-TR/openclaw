import fs from "node:fs/promises";
import path from "node:path";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainLegacyDefaultAgentId } from "../legacy.default-agent-owner.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  ensureSessionEntrySync,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

function fleetConfig(storePath: string, owner?: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      ...(owner ? { defaults: { sessionStore: { agentId: owner } } } : {}),
      entries: { ops: {}, research: {} },
    },
    session: { store: storePath },
  };
}

function turnOptions(config: OpenClawConfig, content: string) {
  return {
    config,
    messages: [userMessage(content)],
    updateMode: "none" as const,
  };
}

const userMessage = (content: string, eventId?: string) => ({
  eventId,
  message: { role: "user", content },
});

function sessionScope(
  home: string,
  sessionId: string,
  agentId?: string,
  sessionKey = "global",
  file = "sessions.json",
) {
  return { agentId, sessionId, sessionKey, storePath: path.join(home, file) };
}

function seedSession(
  scope: ReturnType<typeof sessionScope>,
  fields: Partial<InternalSessionEntry> = {},
) {
  return replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1, ...fields });
}

it.each([
  { phase: "selection", replay: false },
  { phase: "selection", replay: true },
  { phase: "transaction", replay: false },
  { phase: "transaction", replay: true },
])(
  "rejects revoked write authority before commit ($phase, replay: $replay)",
  async ({ phase, replay }) => {
    await withTempHome(async (home) => {
      const scope = sessionScope(home, "source-authority-session", "main", "agent:main:main");
      await seedSession(scope, { lifecycleRevision: "source-generation" });
      const append = {
        eventId: "source-authority-message",
        message: { role: "assistant", content: "Original completion" },
      };
      const options = {
        config: { session: { store: scope.storePath } },
        expectedSessionId: scope.sessionId,
        expectedLifecycleRevision: "source-generation",
        messages: [append],
        updateMode: "none" as const,
      };
      if (replay) {
        await persistSessionTranscriptTurn(scope, options);
      }
      const before = await loadTranscriptEvents(scope);
      const entryBefore = loadSessionEntry(scope);
      let current = true;
      const committed = vi.fn();
      const revokeAt = (boundary: string) => {
        if (phase === boundary) {
          current = false;
        }
        return true;
      };
      const turn = withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          assertCommitAllowed: () => {
            if (!current) {
              throw new Error("original source authority revoked");
            }
          },
          withTranscriptWrite: async (write) => await write(),
        },
        () =>
          persistSessionTranscriptTurn(scope, {
            ...options,
            messages: [
              {
                ...append,
                // Keep the async selection boundary distinct from the transaction guard.
                shouldAppend: async () => revokeAt("selection"),
                shouldAppendInTransaction: () => revokeAt("transaction"),
              },
            ],
            onMessageCommitted: committed,
          }),
      );
      await expect(turn).rejects.toThrow("original source authority revoked");
      expect(committed).not.toHaveBeenCalled();
      expect(await loadTranscriptEvents(scope)).toEqual(before);
      expect(loadSessionEntry(scope)).toEqual(entryBefore);
    });
  },
);

it("completes committed custody before a queued cancellation can interrupt the receipt", async () => {
  await withTempHome(async (home) => {
    const scope = sessionScope(home, "commit-callback-session", "main", "agent:main:main");
    await seedSession(scope);
    const controller = new AbortController();
    const completed: string[] = [];
    const turn = persistSessionTranscriptTurn(scope, {
      config: { session: { store: scope.storePath } },
      expectedSessionId: scope.sessionId,
      messages: [
        {
          eventId: "committed-before-cancellation",
          message: { role: "assistant", content: "Committed notification" },
          shouldAppendInTransaction: () => {
            // Cancellation runs at the first async boundary after SQLite commit.
            queueMicrotask(() => controller.abort(new Error("cancelled after commit")));
            return true;
          },
        },
      ],
      onMessageCommitted: ({ messageId }) => {
        controller.signal.throwIfAborted();
        completed.push(messageId);
      },
      updateMode: "none",
    });
    await expect(turn).resolves.toMatchObject({ appendedCount: 1 });
    expect(controller.signal.aborted).toBe(true);
    expect(completed).toEqual(["committed-before-cancellation"]);
    expect(await loadTranscriptEvents(scope)).toContainEqual(
      expect.objectContaining({ id: "committed-before-cancellation" }),
    );
  });
});

it.each(["undesignated", "retired", "pathless injected"] as const)(
  "rejects an ownerless %s transcript write",
  async (kind) => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const configured = fleetConfig(
        storePath,
        kind === "undesignated" ? undefined : kind === "retired" ? "retired" : "ops",
      );
      const cfg =
        kind === "undesignated" ? retainLegacyDefaultAgentId(configured, "ops") : configured;
      const scope = sessionScope(
        home,
        "ownerless",
        undefined,
        kind === "undesignated" ? "main" : "global",
      );
      const target =
        kind === "pathless injected"
          ? {
              sessionId: scope.sessionId,
              sessionKey: "global",
              sessionStore: { global: { sessionId: scope.sessionId, updatedAt: 1 } },
            }
          : scope;

      await expect(
        persistSessionTranscriptTurn(target, turnOptions(cfg, "must select")),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  },
);

it.each(["recorded default", "explicit per-agent store"] as const)(
  "attributes a write to its %s",
  async (kind) => {
    await withTempHome(async (home) => {
      const explicit = kind === "explicit per-agent store";
      const agentId = explicit ? "research" : "ops";
      const scope = sessionScope(
        home,
        "attributed",
        explicit ? agentId : undefined,
        explicit ? "global" : "main",
        explicit ? "research-sessions.json" : "sessions.json",
      );
      const cfg = explicit
        ? fleetConfig(path.join(home, "shared-sessions.json"), "ops")
        : retainLegacyDefaultAgentId(
            {
              ...fleetConfig(scope.storePath),
              agents: {
                ...fleetConfig(scope.storePath).agents,
                defaults: { systemAgent: { agentId: "ops" } },
              },
            },
            "ops",
          );
      await seedSession({ ...scope, agentId });

      await expect(
        persistSessionTranscriptTurn(scope, {
          ...turnOptions(cfg, kind),
          ...(explicit ? { expectedSessionId: scope.sessionId } : {}),
        }),
      ).resolves.toMatchObject({ appendedCount: 1 });
      await expect(loadTranscriptEvents({ ...scope, agentId })).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: kind, role: "user" }),
          type: "message",
        }),
      );
    });
  },
);

it("rejects a conflicting scope agent for a persisted fixed-store owner", async () => {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    const cfg = fleetConfig(storePath, "ops");
    const scope = sessionScope(home, "persisted-owner-transcript-session", "research");

    await expect(
      persistSessionTranscriptTurn(scope, turnOptions(cfg, "wrong owner")),
    ).rejects.toBeInstanceOf(AgentSelectionRequiredError);

    await seedSession({ ...scope, agentId: "ops" });
    await expect(
      persistSessionTranscriptTurn({ ...scope, agentId: "ops" }, turnOptions(cfg, "right owner")),
    ).resolves.toMatchObject({ appendedCount: 1 });
  });
});

it("completes a pathless injected write before a later failure", async () => {
  await withTempHome(async (home) => {
    const configuredStorePath = path.join(home, "shared-sessions.json");
    const sessionEntry = { sessionId: "injected-research", updatedAt: 1 };
    const sessionStore = { global: sessionEntry };
    const scope = { agentId: "research", sessionId: sessionEntry.sessionId, sessionKey: "global" };
    const cfg = fleetConfig(configuredStorePath, "ops");

    const completed: string[] = [];
    const accepted = createDeferredCore();
    const release = createDeferredCore();
    const settled: string[] = [];
    const turn = persistSessionTranscriptTurn(
      { ...scope, sessionStore },
      {
        config: cfg,
        messages: [
          userMessage("injected research", "injected-first"),
          {
            ...userMessage("cannot commit"),
            prepareMessageAfterIdempotencyCheck: () => {
              throw new Error("second append failed");
            },
          },
        ],
        onMessageCommitted: ({ messageId }, acceptCompletion) => {
          completed.push(messageId);
          acceptCompletion(async () => {
            accepted.resolve();
            await release.promise;
            settled.push(messageId);
          });
        },
        updateMode: "none",
      },
    );
    const outcome = turn.catch((error: unknown) => error);
    try {
      expect(await Promise.race([accepted.promise.then(() => "accepted"), outcome])).toBe(
        "accepted",
      );
      expect(completed).toEqual(["injected-first"]);
      expect(settled).toEqual([]);
      release.resolve();
      await expect(turn).rejects.toThrow("second append failed");
    } finally {
      release.resolve();
      await outcome;
    }
    expect(completed).toEqual(["injected-first"]);
    expect(settled).toEqual(["injected-first"]);
    expect(await loadTranscriptEvents({ ...scope, storePath: configuredStorePath })).toContainEqual(
      expect.objectContaining({ id: "injected-first" }),
    );
  });
});

it.runIf(process.platform !== "win32")(
  "treats a symlink alias as the configured owned fixed store",
  async () => {
    await withTempHome(async (home) => {
      const fixedStorePath = path.join(home, "shared-store.sqlite");
      const aliasStorePath = path.join(home, "shared-store-alias.sqlite");
      await fs.writeFile(fixedStorePath, "");
      await fs.symlink(fixedStorePath, aliasStorePath);
      const cfg = fleetConfig(fixedStorePath, "ops");

      await expect(
        persistSessionTranscriptTurn(
          sessionScope(
            home,
            "aliased-store-session",
            "research",
            "global",
            "shared-store-alias.sqlite",
          ),
          turnOptions(cfg, "wrong owner"),
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  },
);

it.each(["writer", "lifecycle"] as const)(
  "fences transcript mutations with the admitted %s claim",
  async (claim) => {
    await withTempHome(async (home) => {
      const fence = {
        expectedLifecycleRevision: claim === "writer" ? "current-revision" : "superseded-revision",
        expectedWriterRunId: claim === "writer" ? "superseded-run" : "current-run",
      };
      const sensitivePeer = "+15551234567";
      const scope = sessionScope(
        home,
        "session-owned-fence",
        "main",
        `agent:main:owned-fence:${sensitivePeer}\n\x1b[31mspoof`,
      );
      replaceSessionEntrySync(scope, {
        activeWriterRunId: "current-run",
        lifecycleRevision: "current-revision",
        sessionId: scope.sessionId,
        updatedAt: 1,
      } as InternalSessionEntry);

      await withOwnedSessionTranscriptWrites(
        {
          sessionFile: scope.sessionKey,
          sessionKey: scope.sessionKey,
          sessionTarget: {
            ...scope,
            ...fence,
          },
          withTranscriptWrite: async (run) => await run(),
        },
        async () => {
          expect(ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 2 })).toBe(
            true,
          );
          const captureClaimError = (run: () => unknown): unknown => {
            try {
              run();
            } catch (error) {
              return error;
            }
            throw new Error("expected the writer claim to reject transcript persistence");
          };
          const [replacementError, eventError, messageError] = [
            () => replaceTranscriptEventsSync(scope, []),
            () => appendTranscriptEventSync(scope, { type: "custom", id: "stale-event" }),
            () => appendTranscriptMessageSync(scope, userMessage("late", "stale-message")),
          ].map(captureClaimError);
          const expectedCause = {
            actualSessionIdHash: redactIdentifier(scope.sessionId),
            agentIdHash: redactIdentifier(scope.agentId),
            code: "session-rebound",
            expectedSessionIdHash: redactIdentifier(scope.sessionId),
            sessionKeyHash: redactIdentifier(scope.sessionKey),
          };
          for (const error of [eventError, messageError]) {
            expect(error).toMatchObject({ cause: expectedCause });
          }
          await expect(
            appendTranscriptMessage(
              { ...scope, ...fence },
              userMessage("late async append", "stale-async-message"),
            ),
          ).rejects.toMatchObject({
            name: "SessionTranscriptWriterClaimReboundError",
            cause: expectedCause,
          });
          for (const error of [replacementError, eventError, messageError]) {
            expect(error).toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
            const formatted = formatErrorMessage(error);
            for (const secret of [scope.sessionKey, sensitivePeer, "spoof", "\n", "\x1b"]) {
              expect(formatted).not.toContain(secret);
            }
          }
        },
      );

      expect(loadSessionEntry(scope)?.updatedAt).toBe(1);
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
    });
  },
);
it.each(["authority", "idempotency"] as const)(
  "commits a %s-guarded turn without decoding unrelated tool results",
  async (guardKind) => {
    await withOpenClawTestState({ label: "guarded-turn-write-hold" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const scope = {
        agentId: "main",
        sessionId: "guarded-turn",
        sessionKey: "agent:main:guarded-turn",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      appendTranscriptMessageSync(scope, {
        message: {
          role: "toolResult",
          toolCallId: "large-result",
          toolName: "read",
          content: [{ type: "text", text: "synthetic tool output ".repeat(8000) }],
          isError: false,
          timestamp: 1,
        },
      });
      const codec = resolveZstdCodec();
      if (!codec) {
        throw new Error("Transcript hold regression requires native zstd support");
      }
      const decode = vi.spyOn(codec, "decompress");
      const guard = vi.fn(() => true);
      try {
        const committed = await persistSessionTranscriptTurn(scope, {
          expectedSessionId: scope.sessionId,
          updateMode: "none",
          touchSessionEntry: true,
          messages: [
            {
              message: {
                role: "assistant",
                content: "completed",
                timestamp: 2,
                idempotencyKey: "fresh-reply",
              },
              ...(guardKind === "authority"
                ? { shouldAppendInTransaction: guard }
                : { idempotencyLookup: "scan-assistant" as const }),
            },
          ],
        });
        expect(committed.appendedCount).toBe(1);
        expect(guard).toHaveBeenCalledTimes(guardKind === "authority" ? 1 : 0);
        expect(decode).not.toHaveBeenCalled();
      } finally {
        decode.mockRestore();
      }
    });
  },
);
