import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { compactEmbeddedAgentSessionDirect } from "../embedded-agent-runner/compact.js";
import { withSessionCompactionPersistenceAsync } from "../sessions/session-compaction-persistence.js";
import { SessionManager } from "../sessions/session-manager.js";
import { bindBoundedSeed } from "./host-seed.js";

vi.mock("../embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: vi.fn(),
}));

it.each([
  { name: "small history", oldBytes: 20, summary: undefined, expected: 0 },
  { name: "unsummarized history", oldBytes: 4096, summary: undefined, expected: 1 },
  { name: "declined summary", oldBytes: 4096, summary: undefined, expected: 1, decline: true },
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
  async ({ name, oldBytes, summary, expected, revoke, replaceWriter, decline }) => {
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
          manager.appendCompactionAsync("covered old discussion", recent, 2048),
        );
        return { ok: true, compacted: true };
      });
      const prepare = bindBoundedSeed(
        {
          sessionTarget: { ...target, expectedWriterRunId: "seed-writer" },
          workspaceDir: state.workspaceDir,
          config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: 1024 } } } },
        },
        () => {},
        async (run) => run(),
      )?.prepareBoundedSeed;
      expect(prepare).toBeDefined();
      if (!prepare) {
        throw new Error("missing seed capability");
      }
      const result = prepare({ assertCurrent });
      if (revoke || replaceWriter) {
        await expect(result).rejects.toThrow(
          revoke ? "native binding revoked" : /writer|claim|changed/i,
        );
        expect(loadTranscriptEventsSync(target)).toEqual(originalEvents);
      } else {
        const seed = await result;
        expect(Buffer.byteLength(JSON.stringify(seed))).toBeLessThanOrEqual(1024);
        expect(seed).toContainEqual(makeUserMessage("recent request", 2));
        if (expected && !decline) {
          expect(seed).toContainEqual(
            expect.objectContaining({
              role: "compactionSummary",
              summary: "covered old discussion",
            }),
          );
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
