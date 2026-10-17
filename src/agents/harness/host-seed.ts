import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { boundContextEngineAssembly } from "../../context-engine/bounded-context.js";
import { resolveMaxActiveTranscriptBytes } from "../../context-engine/transcript-byte-limit.js";
import { requireCompactionWriterEntry } from "../embedded-agent-runner/compaction-successor.js";
import { attachCompactionAccountingRecorder } from "../embedded-agent-runner/run/compaction-accounting-bridge.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { SessionManager } from "../sessions/session-manager.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

type SeedSourceScope = <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/** The admitted host owns summary persistence; native threads only consume the bounded view. */
export function bindBoundedSeed(
  input: Partial<EmbeddedRunAttemptInternalParams>,
  assertActive: () => void,
  withSource: SeedSourceScope,
  hostSignal?: AbortSignal,
): Pick<AgentHarnessHostCapabilities, "prepareBoundedSeed"> | undefined {
  const { config, workspaceDir, contextEngine } = input;
  const target = input.preparedSessionTarget?.target ?? input.sessionTarget;
  const maxBytes = resolveMaxActiveTranscriptBytes(config);
  if (
    !target?.agentId ||
    !target.sessionId ||
    !target.sessionKey ||
    !target.storePath ||
    !workspaceDir ||
    maxBytes === undefined ||
    contextEngine?.info.ownsCompaction ||
    (contextEngine && contextEngine.info.id !== "legacy")
  ) {
    return undefined;
  }
  const sessionTarget = {
    ...target,
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
  };
  const attempt = {
    ...input,
    sessionTarget,
    abortSignal: hostSignal
      ? input.abortSignal
        ? AbortSignal.any([hostSignal, input.abortSignal])
        : hostSignal
      : input.abortSignal,
  };
  const prepare: NonNullable<AgentHarnessHostCapabilities["prepareBoundedSeed"]> = async ({
    assertCurrent,
    signal: callerSignal,
  }) => {
    const signal =
      callerSignal && attempt.abortSignal
        ? AbortSignal.any([callerSignal, attempt.abortSignal])
        : (callerSignal ?? attempt.abortSignal);
    const assert = () => {
      signal?.throwIfAborted();
      assertActive();
      attempt.preparedSessionTarget?.assertCurrent();
      assertCurrent();
    };
    assert();
    const admission = attempt.userTurnTranscriptRecorder?.getAdmissionReceipt();
    const read = async () => {
      const history = await SessionManager.readSessionContextAsync(
        sessionTarget,
        (items) => Array.from(items),
        { signal },
      );
      assert();
      return history.filter(
        (message) =>
          message.role !== "user" ||
          !admission?.idempotencyKey ||
          Reflect.get(message, "idempotencyKey") !== admission.idempotencyKey,
      );
    };
    let messages = await read();
    let bounded = boundContextEngineAssembly({ messages, estimatedTokens: 0 }, maxBytes);
    const omitted = messages.length - bounded.messages.length;
    if (
      config?.agents?.defaults?.compaction?.enabled !== false &&
      messages.slice(0, omitted).some((message) => message.role !== "compactionSummary")
    ) {
      const entry = await readSessionEntryReadOnlyInWorker(
        { ...sessionTarget, readConsistency: "latest" },
        assert,
      );
      if (!entry || entry.sessionId !== sessionTarget.sessionId) {
        throw new Error("Session changed before preparing native thread history");
      }
      const expected = {
        sessionId: sessionTarget.sessionId,
        lifecycleRevision: sessionTarget.expectedLifecycleRevision ?? entry.lifecycleRevision,
        activeWriterRunId: sessionTarget.expectedWriterRunId ?? entry.activeWriterRunId,
      };
      requireCompactionWriterEntry(entry, expected);
      const writeTarget = {
        ...sessionTarget,
        expectedLifecycleRevision: expected.lifecycleRevision,
        expectedWriterRunId: expected.activeWriterRunId,
        expectedOwner: expected,
      };
      const runtimeContext = { ...attempt.contextEngineRuntimeContext };
      attachCompactionAccountingRecorder(runtimeContext, {
        pendingRequestState: "unresolved",
        pendingUserEntryId: admission?.entryId,
      });
      // The compactor imports harness preparation; loading it eagerly creates a runtime cycle.
      const { compactEmbeddedAgentSessionDirect } =
        await import("../embedded-agent-runner/compact.js");
      assert();
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: writeTarget,
          assertCommitAllowed: assert,
          withTranscriptWrite: async (run) => run(),
        },
        () =>
          compactEmbeddedAgentSessionDirect(
            {
              ...attempt,
              sessionId: sessionTarget.sessionId,
              sessionKey: sessionTarget.sessionKey,
              sessionFile: sessionTarget.sessionKey,
              sessionTarget,
              workspaceDir,
              model: attempt.modelId,
              contextEngineRuntimeContext: runtimeContext,
              trigger: "budget",
              force: true,
              forcePreflight: true,
              preflightRequired: true,
              preflightCompactionTrigger: "transcript_bytes",
              abortSignal: signal,
            },
            (prepared) =>
              persistCompactionBoundaryWithSessionEntryAsync(writeTarget, { prepared }, assert),
          ),
      );
      assert();
      messages = await read();
      bounded = boundContextEngineAssembly({ messages, estimatedTokens: 0 }, maxBytes);
    }
    assert();
    if (bounded.messages.length < messages.length) {
      await attempt.onAgentEvent?.({ stream: "compaction", data: { phase: "context_bounded" } });
      assert();
    }
    return bounded.messages;
  };
  return {
    prepareBoundedSeed: (request) => withSource(() => prepare(request), request.signal),
  };
}
