// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { withSessionEntryWorker } from "../../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import * as sessionGeneration from "../../../config/sessions/session-delivery-generation.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as writerQueue from "../../../shared/store-writer-queue.js";
import { releaseOpenClawAgentDatabaseReadValidation } from "../../../state/openclaw-agent-db-validation-cache.js";
import type { OpenClawAgentDatabaseExecution } from "../../../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../../../state/openclaw-agent-execution.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../../state/openclaw-agent-write-admission-state.js";
import { enqueueSwarmRun, isSwarmRunActive } from "../swarm/swarm-scheduler.js";
import * as killScopeOwner from "./subagent-control-kill-scope.js";
import * as controlSession from "./subagent-control-session.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
});

function holdMetadataPublication(
  signal: AbortSignal,
  consumerScope: AsyncLocalStorage<boolean>,
  beforeHeld?: () => Promise<void>,
  afterReleased?: () => void,
) {
  const producerScope = new AsyncLocalStorage<boolean>();
  const nativeHeld = createDeferredCore();
  const releaseNative = createDeferredCore();
  const state = { holdingResult: false, joinedPublication: false };
  let producerPath: string | undefined;
  const release = () => releaseNative.resolve();
  signal.addEventListener("abort", release, { once: true });
  const runQueued = writerQueue.runQueuedStoreWrite;
  vi.spyOn(writerQueue, "runQueuedStoreWrite").mockImplementation((params) => {
    if (params.queues !== SQLITE_SESSION_WRITER_QUEUES) {
      return runQueued(params);
    }
    if (producerScope.getStore()) {
      producerPath ??= params.storePath;
    }
    const joining =
      consumerScope.getStore() &&
      !producerScope.getStore() &&
      state.holdingResult &&
      params.storePath === producerPath;
    const before = joining
      ? new Set(params.queues.get(params.storePath)?.pending ?? [])
      : undefined;
    const result = runQueued(params);
    if (
      before &&
      params.queues.get(params.storePath)?.pending.some((entry) => !before.has(entry))
    ) {
      state.joinedPublication = true;
      release();
    }
    return result;
  });
  const wrapExecution = (execution: OpenClawAgentDatabaseExecution) => {
    if (!producerScope.getStore()) {
      return execution;
    }
    const runExisting: typeof execution.runExisting = (source, operation, options) =>
      execution.runExisting(
        source,
        (scope) =>
          operation({
            execute(command, commandOptions) {
              const pending = scope.execute(command, commandOptions);
              if (command.type !== "session.entries.replace" || state.holdingResult) {
                return pending;
              }
              state.holdingResult = true;
              // Hold settlement after the native commit has granted publication custody.
              return pending.then(async (value) => {
                if (beforeHeld) {
                  await beforeHeld();
                }
                nativeHeld.resolve();
                await releaseNative.promise;
                afterReleased?.();
                return value;
              });
            },
          }),
        options,
      );
    return new Proxy(execution, {
      get(original, key, receiver) {
        return key === "runExisting" ? runExisting : Reflect.get(original, key, receiver);
      },
    });
  };
  const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
  vi.spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution").mockImplementation((...args) =>
    wrapExecution(capture(...args)),
  );
  const prepare = executionOwner.captureOpenClawAgentDatabasePreparationExecution;
  vi.spyOn(executionOwner, "captureOpenClawAgentDatabasePreparationExecution").mockImplementation(
    (...args) => wrapExecution(prepare(...args)),
  );
  return {
    producerScope,
    nativeHeld,
    state,
    release,
    dispose() {
      signal.removeEventListener("abort", release);
      producerScope.disable();
      consumerScope.disable();
    },
  };
}

function publishMetadata(params: {
  producerScope: AsyncLocalStorage<boolean>;
  storePath: string;
  childKey: string;
  sessionId: string;
  signal: AbortSignal;
  replacement?: boolean;
}) {
  const { producerScope, storePath, childKey, sessionId, signal, replacement } = params;
  const update = () =>
    applySessionEntryExactReplacements({
      agentId: "main",
      storePath,
      sessionKeys: [childKey],
      activeSessionKey: childKey,
      skipMaintenance: true,
      requireWriteSuccess: true,
      update(entries) {
        const row = entries.find((entry) => entry.sessionKey === childKey);
        if (!row || row.entry.sessionId !== sessionId) {
          throw new Error("Metadata producer lost its child");
        }
        return {
          result: undefined,
          replacements: [
            {
              sessionKey: childKey,
              entry: {
                ...row.entry,
                sessionId: replacement ? `${sessionId}-replacement` : sessionId,
                label: "metadata survived",
              },
            },
          ],
        };
      },
    });
  return runOutsideAsyncWorkScope(() =>
    runWithGatewayIndependentRootWorkAdmission(
      () => producerScope.run(true, update),
      "test:pending-metadata",
      signal,
    ),
  );
}

async function registerPublicationRun(runId: string, collect?: boolean) {
  const childKey = `agent:main:subagent:${runId}`;
  const sessionId = `${runId}-session`;
  const parentKey = "agent:main:main";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: childKey,
    defaultSessionId: sessionId,
    lifecycleRevision: `${sessionId}-revision`,
  });
  await registerSubagentRun({
    runId,
    childSessionKey: childKey,
    childAgentId: "main",
    sessionEntry: loadExactSessionEntryReadOnly({ storePath, sessionKey: childKey })?.entry,
    requesterSessionKey: parentKey,
    requesterAgentId: "main",
    requesterDisplayKey: parentKey,
    task: collect ? "held collector publication" : "held metadata publication",
    ...(collect ? { collect: true, queued: false } : {}),
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  return { childKey, sessionId, parentKey, storePath };
}

it.for([
  { replacement: true, competingIdle: false, publication: "tombstone" },
  { replacement: false, competingIdle: true, publication: "tombstone" },
  { replacement: false, competingIdle: false, publication: "result" },
  { replacement: true, competingIdle: false, publication: "result" },
  { replacement: false, competingIdle: false, publication: "discovery" },
])(
  "joins a pending session publication before cancellation $publication (replacement=$replacement, competing idle=$competingIdle)",
  async ({ replacement, competingIdle, publication }, { signal }) => {
    const runId = "pending-kill-publication";
    const { parentKey, childKey, sessionId, storePath } = await registerPublicationRun(runId);
    let peerExecution:
      | ReturnType<typeof executionOwner.captureOpenClawAgentDatabaseExecution>
      | undefined;
    let childPhysicalPath: string | undefined;
    if (competingIdle) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "idle-peer",
        sessionKey: "agent:idle-peer:subagent:retained-execution",
        defaultSessionId: "retained-peer-execution-session",
      });
      const prepareExecution = async (agentId: string) => {
        const retained = executionOwner.captureOpenClawAgentDatabaseExecution({
          agentId,
          env: process.env,
        });
        onTestFinished(() => retained.release());
        await withSessionEntryWorker(
          { agentId, path: retained.path, env: process.env },
          undefined,
          () => retained.assertCurrent(),
          (execution, source) => execution.prepare(source),
          undefined,
          retained,
        );
        retained.captureGenerationClaim().assertCurrent();
        return retained;
      };
      peerExecution = await prepareExecution("idle-peer");
      // Start with the child's original executor idle and the peer still borrowed.
      // The later peer release must cause eviction, not this fixture preparation.
      const childExecution = await prepareExecution("main");
      childPhysicalPath = childExecution.path;
      await childExecution.release();
    }
    const killScope = new AsyncLocalStorage<boolean>();
    let peerReleasedDuringPublication = false;
    let producer: Promise<void> | undefined;
    let producerOutcome: Promise<unknown> | undefined;
    const peer = peerExecution;
    const { producerScope, nativeHeld, state, release, dispose } = holdMetadataPublication(
      signal,
      killScope,
      peer
        ? async () => {
            // Drop transferable validation without retiring the borrowed native writer.
            releaseOpenClawAgentDatabaseReadValidation([{ path: childPhysicalPath! }]);
            await peer.release();
            peerReleasedDuringPublication = true;
          }
        : undefined,
    );
    if (publication === "discovery") {
      const prepareGeneration = sessionGeneration.prepareSessionGenerationFacts;
      vi.spyOn(sessionGeneration, "prepareSessionGenerationFacts").mockImplementation(
        async (input) => {
          const facts = await prepareGeneration(input);
          return {
            ...facts,
            assertCurrent: () => {
              // Let the native writer settle after this synchronous observation.
              // An unprepared discovery still sees the genuinely pending publication.
              if (state.holdingResult) {
                release();
              }
              facts.assertCurrent();
            },
            prepareRead: () => {
              const pending = facts.prepareRead();
              if (state.holdingResult && pending) {
                state.joinedPublication = true;
                release();
              }
              return pending;
            },
          };
        },
      );
    }
    const startProducer = async () => {
      if (!producer) {
        producer = publishMetadata({
          producerScope,
          storePath,
          childKey,
          sessionId,
          signal,
          replacement,
        });
        producerOutcome = producer.then(
          () => ({ ok: true }),
          (error: unknown) => ({ error }),
        );
        await awaitGateBeforeSettlement(
          nativeHeld.promise,
          producer,
          "Metadata publication was not held",
        );
      }
    };
    const acquire = SubagentLifecycleController.prototype.acquireTerminalCompletionLock;
    vi.spyOn(
      SubagentLifecycleController.prototype,
      "acquireTerminalCompletionLock",
    ).mockImplementation(async function (this: SubagentLifecycleController, targetRunId) {
      const unlock = await acquire.call(this, targetRunId);
      if (publication === "tombstone" && targetRunId === runId) {
        await startProducer();
      }
      return unlock;
    });
    const withKillScope = killScopeOwner.withSubagentKillScope;
    vi.spyOn(killScopeOwner, "withSubagentKillScope").mockImplementation(
      (params, run, captureResult, preparePublication, finishResult) =>
        withKillScope(
          params,
          async (scope, trees) => {
            const result = await run(
              publication === "discovery"
                ? {
                    ...scope,
                    refresh: async () => {
                      if (subagentRuns.get(runId)?.execution.status === "terminal") {
                        await startProducer();
                      }
                      return scope.refresh();
                    },
                  }
                : scope,
              trees,
            );
            if (publication === "result") {
              expect(subagentRuns.get(runId)).toMatchObject({
                endedReason: "subagent-killed",
                execution: { status: "terminal" },
              });
              await startProducer();
            }
            return result;
          },
          captureResult,
          preparePublication,
          finishResult,
        ),
    );
    const onResult = vi.fn();
    try {
      const result = await killScope
        .run(true, () =>
          publication === "result"
            ? killSubagentRunAdmin({
                cfg: getRuntimeConfig(),
                sessionKey: childKey,
                agentId: "main",
                expectedRunId: runId,
                onResult,
              })
            : killAllControlledSubagentRuns({
                cfg: getRuntimeConfig(),
                controller: {
                  controllerSessionKey: parentKey,
                  controllerAgentId: "main",
                  callerSessionKey: parentKey,
                  callerIsSubagent: false,
                  controlScope: "children",
                },
                runs: [subagentRuns.get(runId)!],
              }),
        )
        .finally(release);
      if (!replacement && publication !== "result") {
        expect(result, JSON.stringify(result)).toMatchObject({ status: "ok", killed: 1 });
      }
      expect(state).toEqual({ holdingResult: true, joinedPublication: true });
      expect(peerReleasedDuringPublication).toBe(competingIdle);
      expect(await producerOutcome).toEqual({ ok: true });
      const persisted = loadExactSessionEntryReadOnly({ storePath, sessionKey: childKey })?.entry;
      expect(persisted).toMatchObject({
        sessionId: replacement ? `${sessionId}-replacement` : sessionId,
        label: "metadata survived",
      });
      if (publication === "result") {
        expect(onResult).toHaveBeenCalledExactlyOnceWith(result);
        expect(result).toMatchObject({ found: true, killed: true });
        if (replacement) {
          expect(result).toHaveProperty("error", expect.stringContaining("ownership changed"));
          expect(result).not.toHaveProperty("targetState");
        } else {
          expect(result).not.toHaveProperty("error");
          expect(result).toMatchObject({
            targetState: { state: "terminal", task: { status: "cancelled" } },
          });
        }
        return;
      }
      if (replacement) {
        expect(result, JSON.stringify(result)).toMatchObject({ status: "error", killed: 0 });
        expect(persisted?.abortedLastRun).not.toBe(true);
        expect(subagentRuns.get(runId)?.endedReason).not.toBe("subagent-killed");
      } else {
        expect(persisted?.abortedLastRun).toBe(true);
        expect(subagentRuns.get(runId)).toMatchObject({
          endedReason: "subagent-killed",
          execution: { status: "terminal" },
        });
      }
    } finally {
      release();
      await producerOutcome;
      await peerExecution?.release();
      dispose();
    }
  },
);

it("joins a pending session publication before a collector terminal commit", async ({ signal }) => {
  const runId = "pending-collector-publication";
  const { childKey, sessionId, storePath } = await registerPublicationRun(runId, true);
  enqueueSwarmRun({
    groupId: "pending-collector-publication",
    runId: "pending-collector-sibling",
    start: async () => {},
    activeRunIds: [runId],
    maxConcurrent: 1,
    onStartFailure: () => true,
  });
  const completionScope = new AsyncLocalStorage<boolean>();
  let statusWhileJoined: string | undefined;
  let producerOutcome: Promise<unknown> | undefined;
  const { producerScope, nativeHeld, state, release, dispose } = holdMetadataPublication(
    signal,
    completionScope,
    undefined,
    () => {
      // The waiting commit keeps its staged terminal row off-registry.
      statusWhileJoined = subagentRuns.get(runId)?.execution.status;
    },
  );
  const prepareSession = controlSession.prepareSubagentKillSession;
  vi.spyOn(controlSession, "prepareSubagentKillSession").mockImplementation(async (...args) => {
    const session = await prepareSession(...args);
    if (!completionScope.getStore() || args[1] !== childKey || producerOutcome) {
      return session;
    }
    // Completion retained generation facts; a child metadata writer now reaches its
    // native commit before the terminal registry commit.
    const producer = publishMetadata({ producerScope, storePath, childKey, sessionId, signal });
    producerOutcome = producer.then(
      () => ({ ok: true }),
      (error: unknown) => ({ error }),
    );
    await awaitGateBeforeSettlement(
      nativeHeld.promise,
      producer,
      "Metadata publication was not held",
    );
    return {
      ...session,
      // A failed commit still releases its session; never strand the held producer.
      release: async () => {
        release();
        await session.release();
      },
    };
  });
  const startedStatus = subagentRuns.get(runId)?.execution.status;
  try {
    completionScope.run(true, () =>
      emitAgentEvent({
        runId,
        sessionKey: childKey,
        sessionId,
        stream: "lifecycle",
        data: { phase: "end" },
      }),
    );
    await fixture.settle();
    expect(state).toEqual({ holdingResult: true, joinedPublication: true });
    expect(startedStatus).not.toBe("terminal");
    expect(statusWhileJoined).toBe(startedStatus);
    expect(await producerOutcome).toEqual({ ok: true });
    expect(subagentRuns.get(runId)).toMatchObject({ execution: { status: "terminal" } });
    expect(isSwarmRunActive(runId)).toBe(false);
    expect(loadExactSessionEntryReadOnly({ storePath, sessionKey: childKey })?.entry).toMatchObject(
      { sessionId, label: "metadata survived" },
    );
  } finally {
    release();
    await producerOutcome;
    dispose();
  }
});
