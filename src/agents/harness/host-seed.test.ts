import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { compactEmbeddedAgentSessionDirect } from "../embedded-agent-runner/compact.js";
import { withSessionCompactionPersistenceAsync } from "../sessions/session-compaction-persistence.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { bindBoundedSeed } from "./host-seed.js";

// mock-isolation: Keep real transcript and atomic persistence, replacing only summary model execution.
vi.mock("../embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: vi.fn(),
}));

it.each([
  { name: "small history", oldBytes: 20, summary: undefined, expected: 0 },
  { name: "unsummarized history", oldBytes: 4096, summary: undefined, expected: 1 },
  { name: "declined summary", oldBytes: 4096, summary: undefined, expected: 1, decline: true },
  {
    name: "narrow delivery allowance",
    oldBytes: 1000,
    summary: undefined,
    expected: 1,
    maxBytes: 8192,
    contextTokens: 1024,
    requestTokens: 128,
    expectedBytes: 512,
  },
  {
    name: "larger allowance cannot widen host",
    oldBytes: 1000,
    summary: undefined,
    expected: 1,
    maxBytes: 8192,
    contextTokens: 128,
    requestTokens: 1024,
    expectedBytes: 512,
  },
  {
    name: "invalid allowance is ignored",
    oldBytes: 1000,
    summary: undefined,
    expected: 1,
    maxBytes: 8192,
    contextTokens: 128,
    requestTokens: Infinity,
    expectedBytes: 512,
  },
  {
    name: "oversized summary is bounded again",
    oldBytes: 1000,
    summary: undefined,
    expected: 1,
    maxBytes: 8192,
    contextTokens: 128,
    requestTokens: 128,
    expectedBytes: 512,
    oversizedSummary: true,
  },
  {
    name: "omitted existing summary",
    oldBytes: 4096,
    summary: "summary ".repeat(1024),
    expected: 0,
  },
  {
    name: "unsummarized retained tail",
    oldBytes: 4096,
    summary: "older prefix covered",
    expected: 1,
  },
  { name: "revoked source", oldBytes: 4096, summary: undefined, expected: 1, revoke: true },
  { name: "replaced writer", oldBytes: 4096, summary: undefined, expected: 1, replaceWriter: true },
])(
  "prepares a bounded seed for $name",
  async ({
    name,
    oldBytes,
    summary,
    expected,
    revoke,
    replaceWriter,
    decline,
    maxBytes = 1024,
    contextTokens,
    requestTokens,
    expectedBytes = maxBytes,
    oversizedSummary,
  }) => {
    await withOpenClawTestState({ label: "native-seed" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const target = {
        agentId: "main",
        sessionId: "seed",
        sessionKey: "agent:main:seed",
        storePath: state.statePath("sessions.sqlite"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        activeWriterRunId: "seed-writer",
        transcriptByteCompactionLatch: { activeBytes: 4096, maxBytes: 1024, sessionId: "seed" },
      });
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const old = await manager.appendMessageAsync(makeUserMessage("old".repeat(oldBytes), 1));
      const recent = await manager.appendMessageAsync(makeUserMessage("recent request", 2));
      if (summary) {
        await manager.appendCompactionAsync(
          summary,
          name === "unsummarized retained tail" ? old : recent,
          2048,
        );
      }
      const originalEvents = loadTranscriptEventsSync(target);
      const assertCurrent = vi.fn();
      const compact = vi.mocked(compactEmbeddedAgentSessionDirect);
      compact.mockReset();
      compact.mockImplementationOnce(async (_params, persist) => {
        if (decline) {
          return { ok: false, compacted: false, reason: "fixture declines compaction" };
        }
        if (revoke) {
          assertCurrent.mockImplementation(() => {
            throw new Error("native binding revoked");
          });
        }
        if (replaceWriter) {
          await upsertSessionEntryCore(target, { activeWriterRunId: "replacement-writer" });
        }
        await withSessionCompactionPersistenceAsync(manager, persist, () =>
          manager.appendCompactionAsync(
            oversizedSummary ? "generated".repeat(1000) : "covered old discussion",
            recent,
            2048,
          ),
        );
        return { ok: true, compacted: true };
      });
      const prepare = bindBoundedSeed(
        {
          sessionTarget: { ...target, expectedWriterRunId: "seed-writer" },
          workspaceDir: state.workspaceDir,
          contextTokenBudget: contextTokens,
          config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: maxBytes } } } },
        },
        () => {},
        async (run) => run(),
      )?.prepareBoundedSeed;
      expect(prepare).toBeDefined();
      if (!prepare) {
        throw new Error("missing seed capability");
      }
      const result = prepare({ assertCurrent, tokenBudget: requestTokens });
      if (revoke || replaceWriter) {
        await expect(result).rejects.toThrow(
          revoke ? "native binding revoked" : /writer|claim|changed/i,
        );
        expect(loadTranscriptEventsSync(target)).toEqual(originalEvents);
      } else {
        const seed = await result;
        expect(Buffer.byteLength(JSON.stringify(seed))).toBeLessThanOrEqual(expectedBytes);
        expect(seed).toContainEqual(makeUserMessage("recent request", 2));
        if (expected && !decline) {
          if (oversizedSummary) {
            expect(seed.some((message) => message.role === "compactionSummary")).toBe(false);
          } else {
            expect(seed).toContainEqual(
              expect.objectContaining({
                role: "compactionSummary",
                summary: "covered old discussion",
              }),
            );
          }
          expect(loadSessionEntry(target)?.compactionCount).toBe(1);
          expect(loadSessionEntry(target)?.transcriptByteCompactionLatch).toBeUndefined();
        }
        if (decline) {
          expect(loadTranscriptEventsSync(target)).toEqual(originalEvents);
        }
        expect(loadTranscriptEventsSync(target)).toEqual(expect.arrayContaining(originalEvents));
      }
      expect(compact).toHaveBeenCalledTimes(expected);
    });
  },
);

it.each([false, true])(
  "preserves the admitted task only for a refresh seed (%s)",
  async (refresh) => {
    await withOpenClawTestState({ label: "native-refresh-seed" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const target = {
        agentId: "main",
        sessionId: "refresh",
        sessionKey: "agent:main:refresh",
        storePath: state.statePath("sessions.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      await manager.appendMessageAsync(makeUserMessage("Earlier history", 1));
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          ...makeUserMessage("ORIGINAL_ADMITTED_TASK", 2),
          idempotencyKey: "refresh:user",
        },
        target: { ...target, sessionEntry: loadSessionEntry(target), cwd: state.workspaceDir },
      });
      const persisted = await recorder.persistApproved();
      if (!persisted) {
        throw new Error("fixture did not persist its original task");
      }
      const stale = makeAssistantMessageFixture({
        content: [{ type: "text", text: "stale persisted tail" }],
      });
      const current = makeAssistantMessageFixture({
        content: [{ type: "text", text: "authoritative refresh handoff" }],
      });
      const afterAdmission = await SessionManager.openAsync(target, state.workspaceDir);
      await afterAdmission.appendMessageAsync(stale);
      const prepare = bindBoundedSeed(
        {
          sessionTarget: target,
          workspaceDir: state.workspaceDir,
          config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: 8192 } } } },
          userTurnTranscriptRecorder: recorder,
          ...(refresh ? { pluginRuntimeRefreshMessages: [persisted.message, current] } : {}),
        },
        () => {},
        async (run) => run(),
      )?.prepareBoundedSeed;
      if (!prepare) {
        throw new Error("fixture has no seed capability");
      }
      const seed = await prepare({ assertCurrent: () => {} });
      expect(
        seed.filter(
          (message) => message.role === "user" && message.content === "ORIGINAL_ADMITTED_TASK",
        ),
      ).toHaveLength(refresh ? 1 : 0);
      if (refresh) {
        expect(seed).toContainEqual(current);
        expect(seed).not.toContainEqual(stale);
      }
    });
  },
);
