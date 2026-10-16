import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement as awaitGate,
  createDeferred,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as terminalSignals from "../../sessions/subagent-terminal-state.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { applyAcpSessionMutation } from "../runtime/session-meta-write.kernel.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../runtime/session-meta.js";
import {
  withAcpCancellationFixture,
  readDurableAcpSignals,
} from "./manager.cancel-session.worker.test-support.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import { DEFAULT_DEPS } from "./manager.types.js";

type Fixture = Parameters<Parameters<typeof withAcpCancellationFixture>[0]>[0];
type TurnOptions = Partial<Parameters<Fixture["manager"]["runTurn"]>[0]>;

function gate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    wait: () => {
      entered.resolve();
      return release.promise;
    },
  };
}

function holdTurn(f: Fixture, stopReason: "cancel" | undefined, untilAbort = false) {
  const turnGate = gate();
  let signal: AbortSignal | undefined;
  f.runTurn.mockImplementationOnce(async function* (input) {
    signal = input.signal;
    if (untilAbort) {
      input.signal?.addEventListener("abort", turnGate.release, { once: true });
    }
    await turnGate.wait();
    yield stopReason ? { type: "done", stopReason } : { type: "done" };
  });
  return { ...turnGate, signal: () => signal };
}

function cancelOwned(
  f: Fixture,
  options: Partial<Parameters<Fixture["manager"]["cancelSession"]>[0]> = {},
) {
  return f.manager.cancelSession({ ...f.target, expectedOwnerKey: "agent:main:main", ...options });
}

function holdEnsure(f: Fixture, runtimeSessionName: string) {
  const ensureGate = gate();
  f.ensureSession.mockImplementationOnce(async () => {
    await ensureGate.wait();
    return { sessionKey: f.target.sessionKey, backend: "cancellation-proof", runtimeSessionName };
  });
  return ensureGate;
}

function startTurn(f: Fixture, requestId: string, text: string, options: TurnOptions = {}) {
  return f.manager.runTurn({
    ...f.target,
    admittedRunContext: options.admittedRunContext ?? createTestAdmittedRunContext(requestId),
    provenance: "system",
    mode: "prompt",
    text,
    requestId,
    ...options,
  });
}

function trackedTurn(f: Fixture, requestId: string, text: string, options: TurnOptions = {}) {
  const context = createTestAdmittedRunContext(requestId);
  const turn = startTurn(f, requestId, text, { admittedRunContext: context, ...options });
  return {
    turn,
    result: Promise.allSettled([turn]),
    instanceId: context.operationalRunInstance.instanceId,
  };
}

function holdControlRead() {
  const readGate = gate();
  const prepare = DEFAULT_DEPS.prepareSessionControlRead;
  const reader = vi
    .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
    .mockImplementationOnce(async (params) => {
      const read = await prepare(params);
      await readGate.wait();
      return read;
    });
  return { ...readGate, reader };
}

it("refuses inline-only idle ACP metadata without host data SQL", async () => {
  await withAcpCancellationFixture(
    async (f) => {
      const sql = observeHostDataSql();
      try {
        await expect(cancelOwned(f)).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
        sql.restore();
        expect(f.ensureSession).not.toHaveBeenCalled();
        expect(f.cancel).not.toHaveBeenCalled();
        expect(readAcpSessionEntry(f.target)?.entry?.acp?.state).toBe("running");
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    },
    { metadata: "inline" },
  );
});

it("does not admit durable runtime cancellation from an inherited discovery snapshot", async () => {
  await withAcpCancellationFixture(async (f) => {
    const { entered, release } = holdEnsure(f, "retained-runtime");
    const cancellation = withOpenClawStateDatabaseReadSnapshot(() => cancelOwned(f), {
      env: f.state.env,
    });
    const result = Promise.allSettled([cancellation]);
    try {
      await awaitGate(entered, result, "Cancellation ended before runtime preparation.");
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          applyAcpSessionMutation(db, {
            agentId: "main",
            sessionKey: f.target.sessionKey,
            storageSessionKey: f.target.sessionKey,
            entry: {
              sessionId: "cancellation-session",
              lifecycleRevision: "cancellation-lifecycle",
              updatedAt: 100,
            },
            decision: { kind: "clear" },
          }),
        { env: f.state.env },
      );
      release();
      await result;
      expect(f.cancel).not.toHaveBeenCalled();
      expect(readAcpSessionEntry(f.target)?.acp).toBeUndefined();
    } finally {
      release();
      await result;
    }
  });
});

it("joins a failing accepted sibling while another terminal signal remains active", async () => {
  await withAcpCancellationFixture(async (f) => {
    const actorGate = gate();
    f.getStatus.mockImplementationOnce(async () => {
      await actorGate.wait();
      return { summary: "ready" };
    });
    const actor = f.manager.getSessionStatus(f.target);
    const actorResult = Promise.allSettled([actor]);
    await actorGate.entered;
    const secondGate = gate();
    const original = terminalSignals.recordSubagentTerminalState;
    const intercepted = vi
      .spyOn(terminalSignals, "recordSubagentTerminalState")
      .mockImplementation(async (...args) => {
        if (args[0].runId === "sibling-second") {
          await secondGate.wait();
        }
        return original(...args);
      });
    const turns = ["sibling-first", "sibling-second"].map((requestId) =>
      startTurn(f, requestId, "queued", {
        onEvent:
          requestId === "sibling-first"
            ? async () => {
                throw new Error("First cancellation delivery failed.");
              }
            : undefined,
      }),
    );
    const turnResults = Promise.allSettled(turns);
    let settled = false;
    const sql = observeHostDataSql();
    const cancellation = cancelOwned(f);
    const result = Promise.allSettled([cancellation]).then((value) => {
      settled = true;
      return value;
    });
    try {
      await awaitGate(secondGate.entered, turnResults, "Sibling signal was never admitted.");
      await nextTurn();
      expect(settled).toBe(false);
      secondGate.release();
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(await turnResults).toMatchObject([{ status: "rejected" }, { status: "fulfilled" }]);
      sql.restore();
      expect(sql.queries).toEqual([]);
      expect(readDurableAcpSignals(f, "sibling-second")).toMatchObject([{ kind: "run_failed" }]);
      expect(f.cancel).not.toHaveBeenCalled();
    } finally {
      sql.restore();
      secondGate.release();
      actorGate.release();
      intercepted.mockRestore();
      await Promise.allSettled([result, turnResults, actorResult]);
    }
  });
});

it.each(["metadata", "lifecycle"] as const)(
  "refuses late idle runtime effects after %s replacement",
  async (replacement) => {
    await withAcpCancellationFixture(async (f) => {
      const close = vi.spyOn(f.runtime, "close");
      const { entered, release } = holdEnsure(f, "late-runtime");
      const cancellation = cancelOwned(f);
      const result = Promise.allSettled([cancellation]);
      await awaitGate(entered, result, "Cancellation ended before setup.");
      try {
        if (replacement === "metadata") {
          await upsertAcpSessionMeta({ ...f.target, skipMaintenance: true, mutate: () => null });
        } else {
          await replaceSessionEntry(f.target, {
            sessionId: "cancellation-session",
            lifecycleRevision: "replacement-lifecycle",
            updatedAt: 200,
            spawnedBy: "agent:main:main",
          });
        }
      } finally {
        release();
      }
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(f.cancel).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(readAcpSessionEntry(f.target)?.acp).toBeUndefined();
    });
  },
);

it("joins only the superseded actor's late handle after post-ensure control read", async () => {
  await withAcpCancellationFixture(async (f) => {
    const readGate = gate();
    const closeGate = gate();
    let ensured = false;
    let gated = false;
    let settled = false;
    f.ensureSession.mockImplementationOnce(async () => {
      ensured = true;
      return {
        sessionKey: f.target.sessionKey,
        backend: "cancellation-proof",
        runtimeSessionName: "superseded-late-runtime",
      };
    });
    const close = vi.spyOn(f.runtime, "close").mockImplementationOnce(async () => {
      await closeGate.wait();
    });
    const load = DEFAULT_DEPS.loadSessionEntryAsync;
    const read = vi
      .spyOn(DEFAULT_DEPS, "loadSessionEntryAsync")
      .mockImplementation(async (params) => {
        const value = await load(params);
        if (ensured && !gated) {
          gated = true;
          await readGate.wait();
        }
        return value;
      });
    const sql = observeHostDataSql();
    const cancellation = cancelOwned(f, { reason: "old-actor" });
    const result = Promise.allSettled([cancellation]).then((value) => {
      settled = true;
      return value;
    });
    let successor: Promise<void> | undefined;
    try {
      await awaitGate(readGate.entered, result, "Cancellation ended before post-ensure read.");
      await getAcpSessionResetControls(f.manager).forceDiscardSessionRuntime({
        ...f.target,
        reason: "fixture-actor-replacement",
      });
      successor = cancelOwned(f, { reason: "successor-actor" });
      await successor;
      readGate.release();
      await awaitGate(closeGate.entered, result, "Superseded handle was not closed.");
      expect(settled).toBe(false);
      expect(close).toHaveBeenCalledExactlyOnceWith({
        handle: expect.objectContaining({ runtimeSessionName: "superseded-late-runtime" }),
        reason: "session-actor-superseded",
        discardPersistentState: true,
      });
      closeGate.release();
      expect(await result).toMatchObject([{ status: "rejected" }]);
      await f.manager.cancelSession({ ...f.target, reason: "successor-reuse" });
      sql.restore();
      expect(f.ensureSession).toHaveBeenCalledTimes(2);
      expect(f.cancel.mock.calls.map(([input]) => input.reason)).toEqual([
        "successor-actor",
        "successor-reuse",
      ]);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      read.mockRestore();
      readGate.release();
      closeGate.release();
      await Promise.allSettled([result, successor]);
      close.mockRestore();
    }
  });
});

it("refuses caller revocation while the registered cancellation read is pending", async () => {
  await withAcpCancellationFixture(async (f) => {
    const stop = new AbortController();
    const turnGate = holdTurn(f, "cancel", true);
    const { result: turnResult, instanceId } = trackedTurn(f, "caller-worker", "caller", {
      signal: stop.signal,
    });
    await awaitGate(turnGate.entered, turnResult, "Turn ended before runtime entry.");
    const { entered: readEntered, release: readRelease, reader } = holdControlRead();
    let callerCurrent = true;
    const cancellation = cancelOwned(f, {
      expectedRunId: "caller-worker",
      expectedInstanceId: instanceId,
      assertActive: () => {
        if (!callerCurrent) {
          throw new Error("Caller was revoked before admission.");
        }
      },
    });
    const result = Promise.allSettled([cancellation]);
    try {
      await awaitGate(readEntered, result, "Cancellation ended before read gate.");
      callerCurrent = false;
      readRelease();
      expect(await result).toMatchObject([
        { status: "rejected", reason: { message: "Caller was revoked before admission." } },
      ]);
      expect(turnGate.signal()?.aborted).toBe(false);
      expect(f.cancel).not.toHaveBeenCalled();
      expect(readDurableAcpSignals(f, "caller-worker")).toEqual([]);
    } finally {
      readRelease();
      reader.mockRestore();
      stop.abort();
      await Promise.allSettled([result, turnResult]);
    }
  });
});

it.each(["acknowledged", "failed"] as const)(
  "retains %s late-handle cleanup after caller revocation without host data SQL",
  async (outcome) => {
    await withAcpCancellationFixture(async (f) => {
      const { entered: ensureEntered, release: ensureRelease } = holdEnsure(f, "late-runtime");
      const admitted = createDeferred();
      const cancelGate = gate();
      f.cancel.mockImplementationOnce(async () => {
        await cancelGate.wait();
        if (outcome === "failed") {
          throw new Error("Late cancellation failed.");
        }
      });
      const events: unknown[] = [];
      const {
        turn,
        result: turnResult,
        instanceId,
      } = trackedTurn(f, "late-worker", "late", {
        onEvent: (event) => {
          events.push(event);
        },
      });
      await awaitGate(ensureEntered, turnResult, "Turn ended before setup gate.");
      let callerCurrent = true;
      let settled = false;
      const sql = observeHostDataSql();
      let controlPrepared = false;
      const prepare = DEFAULT_DEPS.prepareSessionControlRead;
      const reader = vi
        .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
        .mockImplementationOnce(async (params) => {
          const read = await prepare(params);
          controlPrepared = true;
          return read;
        });
      const cancellation = cancelOwned(f, {
        expectedRunId: "late-worker",
        expectedInstanceId: instanceId,
        assertActive: () => {
          if (!callerCurrent) {
            throw new Error("Caller was revoked.");
          }
          if (controlPrepared) {
            admitted.resolve();
          }
        },
      });
      const result = Promise.allSettled([cancellation, turn]).then((value) => {
        settled = true;
        return value;
      });
      try {
        await awaitGate(admitted.promise, result, "Cancellation ended before admission.");
        callerCurrent = false;
        ensureRelease();
        await awaitGate(cancelGate.entered, result, "Cancellation ended before runtime cleanup.");
        expect(settled).toBe(false);
        expect(f.runTurn).not.toHaveBeenCalled();
        cancelGate.release();
        expect(await result).toMatchObject(
          outcome === "failed"
            ? [
                { status: "rejected", reason: { message: "Late cancellation failed." } },
                { status: "rejected", reason: { message: "Late cancellation failed." } },
              ]
            : [{ status: "fulfilled" }, { status: "fulfilled" }],
        );
        sql.restore();
        expect(f.cancel).toHaveBeenCalledOnce();
        expect(readDurableAcpSignals(f, "late-worker")).toMatchObject([{ kind: "run_failed" }]);
        expect(events).toEqual(
          outcome === "failed" ? [] : [{ type: "done", status: "cancelled", stopReason: "cancel" }],
        );
        expect(sql.queries).toEqual([]);
      } finally {
        reader.mockRestore();
        sql.restore();
        ensureRelease();
        cancelGate.release();
        await Promise.allSettled([result, turnResult]);
      }
    });
  },
);

it("does not adopt a same-request successor after actor replacement during cancellation preparation", async () => {
  await withAcpCancellationFixture(async (f) => {
    let handle = 0;
    f.ensureSession.mockImplementation(async () => ({
      sessionKey: f.target.sessionKey,
      backend: "cancellation-proof",
      runtimeSessionName: `actor-runtime-${++handle}`,
    }));
    const firstGate = holdTurn(f, undefined);
    const nextGate = holdTurn(f, undefined);
    const { result: firstResult, instanceId } = trackedTurn(f, "actor-worker", "first actor");
    await awaitGate(firstGate.entered, firstResult, "First actor ended before entry.");
    const { entered: readEntered, release: readRelease, reader } = holdControlRead();
    const cancellation = cancelOwned(f, {
      reason: "pending-request",
      expectedRunId: "actor-worker",
      expectedInstanceId: instanceId,
    });
    const result = Promise.allSettled([cancellation]);
    let successor: Promise<void> | undefined;
    try {
      await awaitGate(readEntered, result, "Cancellation ended before read gate.");
      await getAcpSessionResetControls(f.manager).forceDiscardSessionRuntime({
        ...f.target,
        reason: "fixture-actor-replacement",
      });
      successor = startTurn(f, "actor-worker", "successor");
      const successorResult = Promise.allSettled([successor]);
      await awaitGate(nextGate.entered, successorResult, "Successor ended before entry.");
      readRelease();
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(nextGate.signal()?.aborted).toBe(false);
      expect(f.cancel.mock.calls.some(([input]) => input.reason === "pending-request")).toBe(false);
    } finally {
      reader.mockRestore();
      readRelease();
      firstGate.release();
      nextGate.release();
      await Promise.allSettled([firstResult, successor, result]);
    }
  });
});

it("joins reentrant cancellation without issuing a second backend effect", async () => {
  await withAcpCancellationFixture(async (f) => {
    const turnGate = holdTurn(f, "cancel", true);
    const cancelGate = gate();
    const { turn, result: turnResult, instanceId } = trackedTurn(f, "reentrant-cancel", "running");
    await turnGate.entered;
    const request = {
      ...f.target,
      expectedRunId: "reentrant-cancel",
      expectedInstanceId: instanceId,
    };
    let nested: Promise<void> | undefined;
    let nestedSettled = false;
    let outerSettled = false;
    f.cancel.mockImplementationOnce(async () => {
      // Launch the reentry without making the backend wait on its own cancellation.
      nested = f.manager.cancelSession({ ...request, reason: "nested" }).then(() => {
        nestedSettled = true;
      });
      void nested.catch(() => {});
      await cancelGate.wait();
    });
    const outer = f.manager.cancelSession({ ...request, reason: "outer" }).then(() => {
      outerSettled = true;
    });
    const outerResult = Promise.allSettled([outer]);
    try {
      await cancelGate.entered;
      await nextTurn();
      expect(f.cancel).toHaveBeenCalledOnce();
      expect([nestedSettled, outerSettled]).toEqual([false, false]);
      cancelGate.release();
      expect(await Promise.allSettled([outer, nested, turn])).toMatchObject([
        { status: "fulfilled" },
        { status: "fulfilled" },
        { status: "fulfilled" },
      ]);
      expect(readDurableAcpSignals(f, "reentrant-cancel")).toMatchObject([{ kind: "run_failed" }]);
    } finally {
      cancelGate.release();
      await Promise.allSettled([outerResult, nested, turnResult]);
    }
  });
});

it.each(["metadata-read", "runtime-rpc"] as const)(
  "retries only a pre-effect refusal after %s cancellation failure",
  async (failure) => {
    await withAcpCancellationFixture(async (f) => {
      const turnGate = holdTurn(f, "cancel");
      const readGate = gate();
      const firstRefusal = createDeferred();
      const secondAdmission = createDeferred();
      let turnSettled = false;
      const { turn, result: initialResult, instanceId } = trackedTurn(f, "retry-cancel", "running");
      const turnResult = initialResult.then((result) => {
        turnSettled = true;
        return result;
      });
      await turnGate.entered;
      const originalMeta = readAcpSessionEntry(f.target)?.acp;
      if (!originalMeta) {
        turnGate.release();
        await turnResult;
        throw new Error("Fixture has no global ACP metadata.");
      }
      const prepare = DEFAULT_DEPS.prepareSessionControlRead;
      let gated = false;
      let observedMissingAcp = false;
      let secondPrepared = false;
      const reader = vi
        .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
        .mockImplementationOnce(async (params) => {
          const read = await prepare(params);
          return {
            ...read,
            readCurrent: async (cfg: typeof f.target.cfg) => {
              const pause = failure === "metadata-read" && turnGate.signal()?.aborted && !gated;
              if (pause) {
                gated = true;
                await readGate.wait();
              }
              const current = await read.readCurrent(cfg);
              if (pause) {
                observedMissingAcp = !current.session.acp;
                firstRefusal.resolve();
              }
              return current;
            },
          };
        })
        .mockImplementationOnce(async (params) => {
          const read = await prepare(params);
          secondPrepared = true;
          return read;
        });
      if (failure === "runtime-rpc") {
        f.cancel.mockImplementationOnce(async () => {
          firstRefusal.resolve();
          throw new Error("Cancellation RPC failed after starting.");
        });
      }
      const request = {
        ...f.target,
        expectedRunId: "retry-cancel",
        expectedInstanceId: instanceId,
        expectedOwnerKey: "agent:main:main",
      };
      const first = f.manager.cancelSession({ ...request, reason: "first-stop" });
      const firstResult = Promise.allSettled([first]);
      let second: Promise<void> | undefined;
      try {
        if (failure === "metadata-read") {
          await readGate.entered;
          await upsertAcpSessionMeta({ ...f.target, skipMaintenance: true, mutate: () => null });
          readGate.release();
        }
        await firstRefusal.promise;
        // Let the active cancellation reject while the producer is still held open.
        await nextTurn();
        expect(turnGate.signal()?.aborted).toBe(true);
        expect(turnSettled).toBe(false);
        expect(f.cancel).toHaveBeenCalledTimes(failure === "runtime-rpc" ? 1 : 0);
        if (failure === "metadata-read") {
          expect(observedMissingAcp).toBe(true);
          await upsertAcpSessionMeta({
            ...f.target,
            skipMaintenance: true,
            mutate: () => originalMeta,
          });
        }
        second = f.manager.cancelSession({
          ...request,
          reason: "second-stop",
          assertActive: () => {
            if (secondPrepared) {
              secondAdmission.resolve();
            }
          },
        });
        const secondResult = Promise.allSettled([second]);
        await awaitGate(
          secondAdmission.promise,
          secondResult,
          "Second Stop ended before fresh control admission.",
        );
        expect(turnSettled).toBe(false);
        turnGate.release();
        expect(await Promise.allSettled([first, second, turn])).toMatchObject([
          {
            status: "rejected",
            reason: {
              code: "ACP_TURN_FAILED",
              message:
                failure === "metadata-read"
                  ? "ACP task owner could not be verified."
                  : "Cancellation RPC failed after starting.",
            },
          },
          failure === "metadata-read"
            ? { status: "fulfilled" }
            : {
                status: "rejected",
                reason: { message: "Cancellation RPC failed after starting." },
              },
          { status: "fulfilled" },
        ]);
        expect(f.cancel).toHaveBeenCalledOnce();
      } finally {
        readGate.release();
        turnGate.release();
        await Promise.allSettled([firstResult, second, turnResult]);
        reader.mockRestore();
      }
    });
  },
);
