import { expect, it } from "vitest";
import { resolveSessionWorkStartError } from "./lifecycle.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";
import type { InternalSessionEntry } from "./types.js";

const sessionId = "sharing-lifecycle";
const tombstone = {
  cycleId: "recovery-cycle",
  revision: 1,
  chargedAttempts: 1,
  tombstone: { reason: "recovery exhausted" },
} satisfies NonNullable<InternalSessionEntry["mainRestartRecovery"]>;

const cases: Array<{
  name: string;
  changes: Partial<InternalSessionEntry>;
  message?: string;
}> = [
  { name: "allowed session", changes: {} },
  {
    name: "provider pause",
    changes: {
      providerReview: {
        id: "review-1",
        sessionId,
        runId: "refused-run",
        provider: "openai",
        model: "test-model",
        runtimeId: "codex",
      },
    },
    message: "paused as a precaution",
  },
  {
    name: "pending initialization",
    changes: { initializationPending: true },
    message: "still initializing",
  },
  {
    name: "incognito age despite recent activity",
    changes: { incognito: true, createdAt: 1 },
    message: "expired",
  },
  {
    name: "restart tombstone",
    changes: { mainRestartRecovery: tombstone },
    message: "Use Resume in WebChat",
  },
  {
    name: "restart tombstone with model lock",
    changes: { mainRestartRecovery: tombstone, modelSelectionLocked: true },
    message: "cannot be replaced while model selection is locked",
  },
  {
    name: "pending project",
    changes: { pendingProjectGitUrl: "https://github.com/example/project.git" },
    message: "workspace is not ready",
  },
  {
    name: "pending worktree",
    changes: { pendingWorktree: { titleSource: "New checkout" } },
    message: "workspace is not ready",
  },
];

it.each(cases)(
  "preserves $name work-start behavior in retained sharing facts",
  ({ changes, message }) => {
    const entry: InternalSessionEntry = { sessionId, updatedAt: Date.now(), ...changes };
    const key = entry.incognito ? "agent:main:dashboard:incognito-lifecycle" : "agent:main:main";
    const expected = resolveSessionWorkStartError(key, entry);
    if (message) {
      expect(expected).toContain(message);
    } else {
      expect(expected).toBeUndefined();
    }
    expect(resolveSessionWorkStartError(key, projectSessionSharingEntry(entry))).toBe(expected);
  },
);
