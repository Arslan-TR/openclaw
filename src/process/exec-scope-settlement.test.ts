import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import type { CommandProcessCustody } from "./command-process-custody.types.js";
import { CommandProcessCleanupError, hasCommandProcessCleanupError } from "./exec-result.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import {
  COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS,
  spawnCommand,
  withCommandProcessScope,
} from "./exec-spawn.js";
import { runExec } from "./exec.js";
import { BrokerChild } from "./spawn-broker/child.js";

const transport = vi.hoisted(() => ({ spawn: vi.fn(), settle: vi.fn() }));
vi.mock("execa", () => ({ execa: transport.spawn }));
vi.mock("./windows-command.js", () => ({
  resolveSafeChildProcessInvocation: ({ argv }: { argv: string[] }) => ({
    command: argv[0],
    args: argv.slice(1),
    windowsHide: true,
    windowsVerbatimArguments: false,
    usesWindowsExitCodeShim: false,
  }),
}));
vi.mock("../shared/pid-alive.js", () => ({
  getFileLockProcessStartTime: () => 1,
  getProcessInstanceStartTime: () => 1,
}));
vi.mock("./kill-tree.js", () => ({ killProcessTree: vi.fn() }));
vi.mock("./exec-termination.js", () => ({
  createCommandTerminationController: () => ({ terminate: () => false, settle: transport.settle }),
}));

const scopes: Promise<unknown>[] = [];
const fixtures: Array<() => void> = [];
const uncertainCleanup = { code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" };
const emptyResult = {
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  exitCode: 0,
  failed: false,
  timedOut: false,
  isCanceled: false,
  isMaxBuffer: false,
  isTerminated: false,
  isForcefullyTerminated: false,
};
const spawnFixture = () => spawnCommand(["fixture"], { reject: false });

function ownScope<T>(
  run: (stop: () => void) => Promise<T>,
  custody?: CommandProcessCustody,
): Promise<T> {
  const scope = withCommandProcessScope(run, undefined, custody);
  scopes.push(scope);
  void scope.catch(() => {});
  return scope;
}

function observeScope<T>(run: (stop: () => void) => Promise<T>, custody?: CommandProcessCustody) {
  const state = { finished: false };
  const scope = ownScope(run, custody).finally(() => {
    state.finished = true;
  });
  return { state, scope, outcome: scope.catch((error: unknown) => error) };
}

const makeReservation = () => ({ spawned: vi.fn(), settled: vi.fn() });

function commandFixture() {
  const child = new BrokerChild(1, ["fixture"], async () => {});
  const ready = createDeferredCore();
  const closed = createDeferredCore();
  const result = createDeferredCore<typeof emptyResult>();
  const cleanup = createDeferredCore<"forced" | "uncertain">();
  vi.spyOn(child, "ready").mockReturnValue(ready.promise);
  vi.spyOn(child, "waitForClose").mockReturnValue(closed.promise);
  const command = Object.defineProperties(result.promise, {
    nodeChildProcess: { value: child },
    pid: { get: () => child.pid },
    kill: { value: vi.fn(() => true) },
  });
  transport.spawn.mockReturnValue(command);
  transport.settle.mockReturnValue(cleanup.promise);
  const fixture = {
    child,
    closed,
    cleanup,
    result,
    open() {
      child.pid = 424242;
      ready.resolve();
    },
    finish(close = true) {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      result.resolve({ ...emptyResult });
      if (close) {
        closed.resolve();
      }
    },
    complete() {
      fixture.open();
      fixture.finish();
    },
    fail(error: Error) {
      ready.reject(error);
      result.reject(error);
      closed.resolve();
    },
  };
  fixtures.push(() => {
    fixture.complete();
    cleanup.resolve("forced");
  });
  return fixture;
}

beforeEach(() => {
  transport.spawn.mockReset();
  transport.settle.mockReset();
  // Synthetic PIDs never reach the operating system.
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("synthetic group has exited"), { code: "ESRCH" });
  });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of fixtures.splice(0)) {
    dispose();
  }
  await Promise.allSettled(scopes.splice(0));
  vi.restoreAllMocks();
});

it.each(["resolved", "rejected"] as const)("custody survives %s transport", async (result) => {
  const fixture = commandFixture();
  const reservation = makeReservation();
  const reserve = vi.fn(() => reservation);
  const spawn = transport.spawn.getMockImplementation()!;
  transport.spawn.mockImplementation((...args) => {
    expect(reserve).toHaveBeenCalledExactlyOnceWith(["fixture"]);
    return spawn(...args);
  });
  const failure = new Error("transport failed");
  const { state, scope, outcome } = observeScope(
    () => ownScope(async () => void (await spawnFixture())),
    {
      reserve,
    },
  );
  expect(reservation.spawned).not.toHaveBeenCalled();
  fixture.open();
  await setImmediate();
  expect(reservation.spawned).toHaveBeenCalledExactlyOnceWith({ pid: 424242, startedAt: 1 });
  if (result === "rejected") {
    fixture.child.exitCode = 0;
    fixture.child.emit("exit", 0, null);
    fixture.result.reject(failure);
  } else {
    fixture.finish(false);
  }
  await setImmediate();
  expect(state.finished).toBe(false);
  expect(reservation.settled).not.toHaveBeenCalled();
  fixture.closed.resolve();
  if (result === "rejected") {
    expect(await outcome).toBe(failure);
  } else {
    await scope;
  }
  expect(reservation.settled).toHaveBeenCalledOnce();
});

it.each([false, true])("retains unproven launches: %s", async (notStarted) => {
  const fixture = commandFixture();
  const reservation = makeReservation();
  const { outcome } = observeScope(async () => void (await spawnFixture()), {
    reserve: () => reservation,
  });
  if (notStarted) {
    fixture.child.markNotStarted();
  }
  const failure = new Error("broker lost before PID delivery");
  fixture.fail(failure);
  if (notStarted) {
    expect(await outcome).toBe(failure);
  } else {
    expect(await outcome).toMatchObject({
      code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
      cause: failure,
    });
  }
  expect(reservation.spawned).not.toHaveBeenCalled();
  expect(reservation.settled).toHaveBeenCalledTimes(notStarted ? 1 : 0);
});

it.each([false, true])("failed custody blocks input (live: %s)", async (live) => {
  const fixture = commandFixture();
  fixture.child.stdin = new PassThrough();
  const beforeInput = vi.fn();
  const reservation = {
    spawned: vi.fn(() => {
      throw new Error("custody receipt unavailable");
    }),
    settled: vi.fn(),
  };
  const { outcome } = observeScope(
    async () => {
      await runCommandWithTimeout(["fixture"], { input: "private input", beforeInput });
    },
    { reserve: () => reservation },
  );
  if (live) {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockReturnValue(true);
  }
  fixture.open();
  await setImmediate();
  fixture.finish();
  fixture.cleanup.resolve("forced");
  if (live) {
    await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS + 1);
    vi.useRealTimers();
  }
  expect(await outcome).toMatchObject(uncertainCleanup);
  expect(beforeInput).not.toHaveBeenCalled();
  expect(reservation.settled).toHaveBeenCalledTimes(live ? 0 : 1);
});

it.each([
  ["forced", false],
  ["uncertain", false],
  ["forced", true],
  ["uncertain", true],
] as const)("%s cleanup outlives result (nested: %s)", async (cleanup, nested) => {
  const fixture = commandFixture();
  const resultSeen = createDeferredCore();
  const finishLogical = createDeferredCore();
  const original = new Error("nested operation cancelled");
  const run = async () => {
    const controller = new AbortController();
    const pending = runCommandWithTimeout(["fixture"], {
      signal: controller.signal,
      killProcessTree: true,
    });
    controller.abort();
    expect(await pending).toMatchObject({ termination: "signal", cleanup: "uncertain" });
    resultSeen.resolve();
    if (nested) {
      await finishLogical.promise;
      throw original;
    }
  };
  const { state, outcome } = observeScope(async () => {
    if (!nested) {
      return await run();
    }
    void ownScope(run).catch(() => {});
    return "parent finished its callback";
  });
  try {
    await resultSeen.promise;
    await setImmediate();
    expect(state.finished).toBe(false);
    fixture.complete();
    await setImmediate();
    expect(state.finished).toBe(false);
    fixture.cleanup.resolve(cleanup);
    await setImmediate();
    expect(state.finished).toBe(true);
    const result = await outcome;
    if (cleanup === "uncertain") {
      expect(result).toMatchObject(uncertainCleanup);
      if (nested) {
        expect(hasCommandProcessCleanupError(result)).toBe(true);
      }
    } else {
      expect(result).toBe(nested ? "parent finished its callback" : undefined);
    }
  } finally {
    finishLogical.resolve();
    await outcome;
  }
});

it.each(["exec", "spawn"] as const)("retains %s admitted before remote readiness", async (api) => {
  const fixture = commandFixture();
  const failure = new Error("caller stopped");
  const { state, outcome } = observeScope(async () => {
    const pending = api === "exec" ? runExec("fixture", [], { logOutput: false }) : spawnFixture();
    void pending.catch(() => {});
    throw failure;
  });
  await setImmediate();
  expect(state.finished).toBe(false);
  fixture.complete();
  expect(await outcome).toBe(failure);
});

it.skipIf(process.platform === "win32")("live groups stay uncertain", async () => {
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockReturnValue(true);
  const fixture = commandFixture();
  const { outcome } = observeScope(async () => void (await spawnFixture()));
  fixture.complete();
  await vi.advanceTimersByTimeAsync(COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS + 1);
  expect(await outcome).toMatchObject(uncertainCleanup);
});

it.skipIf(process.platform === "win32")("joins late group extinction", async () => {
  vi.useFakeTimers();
  const disappearsAt = Date.now() + 1_000;
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("synthetic group probe"), {
      code: Date.now() < disappearsAt ? "EPERM" : "ESRCH",
    });
  });
  const fixture = commandFixture();
  const reservation = makeReservation();
  const scope = ownScope(async () => void (await spawnFixture()), { reserve: () => reservation });
  fixture.complete();
  await vi.advanceTimersByTimeAsync(999);
  expect(reservation.settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(scope).resolves.toBeUndefined();
  expect(reservation.settled).toHaveBeenCalledOnce();
});

it("keeps Windows transport failure uncertain without a native exit", async () => {
  await withMockedWindowsPlatform(async () => {
    const fixture = commandFixture();
    const { outcome } = observeScope(async () => {
      const pending = spawnFixture();
      fixture.open();
      await setImmediate();
      fixture.fail(new Error("transport failed after readiness"));
      await pending.catch(() => {});
    });
    expect(await outcome).toMatchObject(uncertainCleanup);
  });
});

it("closes nested native admission without waiting for its logical callback", async () => {
  const finishLogical = createDeferredCore();
  let nested: Promise<unknown> | undefined;
  const { state, scope: outer } = observeScope(async () => {
    nested = ownScope(async () => {
      await finishLogical.promise;
      return await spawnCommand(["fixture"]);
    }).catch((error: unknown) => error);
    return "parent finished";
  });
  try {
    await setImmediate();
    expect(state.finished).toBe(true);
    expect(await outer).toBe("parent finished");
  } finally {
    finishLogical.resolve();
    await Promise.allSettled([outer, nested]);
  }
  expect(await nested).toMatchObject({ message: "Command process scope is closed" });
  expect(transport.spawn).not.toHaveBeenCalled();
});

it("preserves canonical cleanup remedies through nested scopes and module copies", async () => {
  const original = new CommandProcessCleanupError();
  expect(hasCommandProcessCleanupError(new AggregateError([original], "outer"))).toBe(true);
  const unrelated = Object.assign(new Error("private unrelated failure"), { code: original.code });
  expect(hasCommandProcessCleanupError(unrelated)).toBe(false);
  expect(new CommandProcessCleanupError({ cause: unrelated })).toMatchObject({
    message: "Command cleanup could not confirm that owned work stopped",
    cause: unrelated,
  });
  vi.resetModules();
  const duplicate = await import("./exec-result.js");
  const refusal = new duplicate.CommandProcessCleanupError();
  const message =
    "Doctor processes remain unsettled, data-at-risk. PIDs/process groups: 424242; resolve retained process custody before retrying `openclaw update repair`.";
  refusal.message = message;
  const cause = new AggregateError(
    [original, new Error("private wrapper", { cause: refusal })],
    "private aggregate",
    { cause: unrelated },
  );
  const failure = await ownScope(() =>
    ownScope(() =>
      ownScope(async () => {
        throw cause;
      }),
    ),
  ).catch((error: unknown) => error);
  expect(hasCommandProcessCleanupError(failure)).toBe(true);
  expect(failure).toMatchObject({ message, code: original.code, cleanup: "uncertain" });
  expect(collectNestedErrorCandidates(failure)).toContain(cause);
});
