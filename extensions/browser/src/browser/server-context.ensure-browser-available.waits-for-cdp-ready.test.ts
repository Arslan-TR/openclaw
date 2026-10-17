import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import { PROFILE_ATTACH_RETRY_TIMEOUT_MS } from "./cdp-timeouts.js";
import type { RunningChrome } from "./chrome.js";
import * as chromeModule from "./chrome.js";
import { BROWSER_ERROR_REASONS, BrowserProfileUnavailableError } from "./errors.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition, getProfileLifecycle } from "./server-context.lifecycle.js";
import {
  makeBrowserProfile,
  makeBrowserServerState,
  mockLaunchedChrome,
} from "./server-context.test-harness.js";
import type { ProfileRuntimeState } from "./server-context.types.js";

const PROFILE_HTTP_REACHABILITY_TIMEOUT_MS = 300;
const chrome = {
  launch: vi.mocked(chromeModule.launchOpenClawChrome),
  stop: vi.mocked(chromeModule.stopOpenClawChrome),
  reachable: vi.mocked(chromeModule.isChromeReachable),
  ownsCdp: vi.mocked(chromeModule.isChromeCdpOwnedByPid),
  ready: vi.mocked(chromeModule.isChromeCdpReady),
  inspectMode: vi.mocked(chromeModule.inspectLocalChromeHeadlessMode),
};

function fakeRunning(pid: number): RunningChrome {
  return mockLaunchedChrome(vi.fn(), pid);
}

function deferLaunch() {
  const entered = Promise.withResolvers<void>();
  const launch = Promise.withResolvers<RunningChrome>();
  chrome.launch.mockImplementationOnce(async () => {
    entered.resolve();
    return await launch.promise;
  });
  return { entered, launch };
}

function setupEnsureBrowserAvailableHarness() {
  vi.useFakeTimers();

  chrome.reachable.mockResolvedValue(false);
  chrome.ownsCdp.mockResolvedValue(true);

  const state = makeBrowserServerState();
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profile = ctx.forProfile("openclaw");

  return { profile, state };
}

function createAttachOnlyLoopbackProfile(cdpUrl: string) {
  const state = makeBrowserServerState({
    profile: makeBrowserProfile({
      name: "manual-cdp",
      cdpUrl,
      cdpPort: 9222,
      attachOnly: true,
    }),
    resolvedOverrides: {
      defaultProfile: "manual-cdp",
      ssrfPolicy: {},
    },
  });
  const ctx = createBrowserRouteContext({ getState: () => state });
  return { profile: ctx.forProfile("manual-cdp"), state };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser server-context ensureBrowserAvailable", () => {
  it("keeps a shared launch running when one caller cancels its wait", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const { entered, launch } = deferLaunch();
    const running = fakeRunning(1200);
    chrome.ready.mockResolvedValue(true);

    const first = profile.ensureBrowserAvailable({ signal: controller.signal });
    const second = createBrowserRouteContext({ getState: () => state })
      .forProfile()
      .ensureBrowserAvailable();
    await entered.promise;
    const cancelled = expect(first).rejects.toBe(reason);
    controller.abort(reason);
    await cancelled;
    launch.resolve(running);
    await expect(second).resolves.toBeUndefined();

    expect(state.profiles.get("openclaw")?.running).toBe(running);
    expect(chrome.launch).toHaveBeenCalledOnce();
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("rejects and cleans a deferred launch before stop returns, then allows restart", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    const { entered: launchEntered, launch: deferredLaunch } = deferLaunch();
    const late = fakeRunning(1201);
    const replacement = fakeRunning(1202);
    chrome.launch.mockResolvedValueOnce(replacement);
    chrome.ready.mockResolvedValue(true);

    const start = profile.ensureBrowserAvailable();
    await launchEntered.promise;
    expect(chrome.launch).toHaveBeenCalledTimes(1);
    const stopping = profile.stopRunningBrowser();
    deferredLaunch.resolve(late);

    await expect(start).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(stopping).resolves.toEqual({ stopped: true });
    expect(chrome.stop).toHaveBeenCalledTimes(1);
    expect(chrome.stop).toHaveBeenCalledWith(late);
    expect(state.profiles.get("openclaw")?.running).toBeNull();
    const runtime = state.profiles.get("openclaw");
    expect(runtime ? getProfileLifecycle(runtime).handles.size : 0).toBe(0);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
    expect(state.profiles.get("openclaw")?.running).toBe(replacement);
  });

  it("does not count canceled managed starts toward the launch cooldown", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    chrome.ready.mockResolvedValue(true);
    const runtime = state.profiles.get("openclaw");
    if (!runtime) {
      throw new Error("expected openclaw runtime");
    }
    const previousFailure = {
      consecutiveFailures: 2,
      lastError: "earlier launch failure",
    };
    runtime.managedLaunchFailure = previousFailure;
    const { entered: launchEntered, launch: deferredLaunch } = deferLaunch();

    const start = profile.ensureBrowserAvailable();
    await launchEntered.promise;
    const canceling = beginProfileTransition({
      state,
      runtime,
      reason: "profile config changed",
    });
    deferredLaunch.resolve(fakeRunning(1300));

    await expect(start).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(canceling).resolves.toEqual({ stopped: true });
    expect(runtime.managedLaunchFailure).toBe(previousFailure);

    const replacement = fakeRunning(1400);
    chrome.launch.mockResolvedValueOnce(replacement);
    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(chrome.launch).toHaveBeenCalledTimes(2);
    expect(chrome.stop).toHaveBeenCalledTimes(1);
    expect(state.profiles.get("openclaw")?.running).toBe(replacement);
    expect(state.profiles.get("openclaw")?.managedLaunchFailure).toBeUndefined();
  });

  it("keeps Chrome across startup and later operations when readiness responses take 750ms", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    chrome.ready.mockImplementation(
      async (_url, timeoutMs = 0) =>
        await new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(timeoutMs >= 750), Math.min(750, timeoutMs));
        }),
    );
    const launched = mockLaunchedChrome(chrome.launch, 124);

    const ready = expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(8100);
    await ready;

    vi.mocked(chromeModule.isChromeReachable).mockImplementation(async () =>
      Boolean(state.profiles.get("openclaw")?.running),
    );
    const reused = expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(8100);
    await reused;

    expect(chrome.launch).toHaveBeenCalledTimes(1);
    expect(state.profiles.get("openclaw")?.running).toBe(launched);
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("stops launched chrome when CDP readiness never arrives", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    state.resolved.localCdpReadyTimeoutMs = 250;
    chrome.ready.mockResolvedValue(false);
    mockLaunchedChrome(chrome.launch, 321);

    const promise = profile.ensureBrowserAvailable();
    const rejected = expect(promise).rejects.toThrow("not reachable after start");
    const diagnosticRejected = expect(promise).rejects.toThrow(
      "CDP diagnostic: websocket_health_command_timeout; mock CDP diagnostic.",
    );
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    await diagnosticRejected;

    expect(chrome.launch).toHaveBeenCalledTimes(1);
    expect(chrome.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign listener that wins the managed CDP port after spawn", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    const launched = fakeRunning(1234);
    chrome.launch.mockResolvedValue(launched);
    chrome.ready.mockResolvedValue(true);
    chrome.ownsCdp.mockResolvedValue(false);

    await expect(profile.ensureBrowserAvailable()).rejects.toThrow("did not own its CDP endpoint");

    expect(chrome.ownsCdp).toHaveBeenCalledWith(
      "http://127.0.0.1:18800",
      launched.pid,
      expect.any(Number),
      undefined,
      expect.any(AbortSignal),
    );
    expect(chrome.stop).toHaveBeenCalledExactlyOnceWith(launched);
    expect(state.profiles.get("openclaw")?.running).toBeNull();
  });

  it("does not adopt a managed child that exits during the ownership probe", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    const launched = fakeRunning(1235);
    const ownershipEntered = Promise.withResolvers<void>();
    const ownership = Promise.withResolvers<boolean>();
    chrome.launch.mockResolvedValue(launched);
    chrome.ready.mockResolvedValue(true);
    chrome.ownsCdp.mockImplementationOnce(async () => {
      ownershipEntered.resolve();
      return await ownership.promise;
    });

    const start = profile.ensureBrowserAvailable();
    await ownershipEntered.promise;
    launched.proc.emit("exit", 0, null);
    ownership.resolve(true);

    await expect(start).rejects.toThrow("exited before adoption");
    const runtime = state.profiles.get("openclaw");
    expect(runtime?.running).toBeNull();
    expect(runtime ? getProfileLifecycle(runtime).handles.size : 0).toBe(0);
    expect(chrome.stop).toHaveBeenCalledExactlyOnceWith(launched);
  });

  it("passes request-local headless override to the owned restart path", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    const runtime = state.profiles.get("openclaw");
    if (!runtime) {
      throw new Error("expected openclaw runtime");
    }
    runtime.running = fakeRunning(111);
    chrome.reachable.mockImplementation(async () => Boolean(runtime.running));
    chrome.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockLaunchedChrome(chrome.launch, 987);

    await expect(profile.ensureBrowserAvailable({ headless: true })).resolves.toBeUndefined();

    expect(chrome.stop).toHaveBeenCalledTimes(1);
    expect(chrome.launch).toHaveBeenCalledTimes(1);
    expect(chrome.launch.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ headlessOverride: true, signal: expect.any(AbortSignal) }),
    );
  });

  it("clears the concurrent lazy-start guard after launch failure", async () => {
    const { profile } = setupEnsureBrowserAvailableHarness();
    chrome.ready.mockResolvedValue(true);
    chrome.launch.mockRejectedValueOnce(
      new Error("PortInUseError: listen EADDRINUSE 127.0.0.1:18800"),
    );

    const first = profile.ensureBrowserAvailable();
    const second = profile.ensureBrowserAvailable();
    await expect(Promise.all([first, second])).rejects.toThrow("PortInUseError");

    mockLaunchedChrome(chrome.launch, 789);
    const retry = profile.ensureBrowserAvailable();
    await vi.advanceTimersByTimeAsync(100);
    await expect(retry).resolves.toBeUndefined();

    expect(chrome.launch).toHaveBeenCalledTimes(2);
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("cools down repeated managed Chrome launch failures across route contexts", async () => {
    const { state } = setupEnsureBrowserAvailableHarness();
    chrome.ready.mockResolvedValue(true);
    chrome.launch.mockRejectedValue(new Error("Failed to start Chrome CDP"));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ctx = createBrowserRouteContext({ getState: () => state });
      await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
        "Failed to start Chrome CDP",
      );
    }

    const cooledDownCtx = createBrowserRouteContext({ getState: () => state });
    await expect(cooledDownCtx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      'Browser launch for profile "openclaw" is cooling down after 3 consecutive managed Chrome launch failures.',
    );
    await expect(cooledDownCtx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      "set browser.enabled=false if the browser tool is not needed",
    );

    expect(chrome.launch).toHaveBeenCalledTimes(3);
    expect(chrome.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(cooledDownCtx.forProfile().ensureBrowserAvailable()).rejects.toThrow(
      "Failed to start Chrome CDP",
    );
    expect(chrome.launch).toHaveBeenCalledTimes(4);
  });

  it("does not let no-display preflight failures block explicit headless recovery", async () => {
    const { state } = setupEnsureBrowserAvailableHarness();
    chrome.ready.mockResolvedValue(true);
    chrome.launch.mockRejectedValue(
      new BrowserProfileUnavailableError("display required", {
        metadata: {
          reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
          details: {
            profile: "openclaw",
            requestedHeadless: false,
            headlessSource: "config",
            displayPresent: false,
          },
        },
      }),
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ctx = createBrowserRouteContext({ getState: () => state });
      await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
        "display required",
      );
    }

    mockLaunchedChrome(chrome.launch, 987);
    const recoveryCtx = createBrowserRouteContext({ getState: () => state });
    const recovery = recoveryCtx.forProfile("openclaw").ensureBrowserAvailable({ headless: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(recovery).resolves.toBeUndefined();

    expect(chrome.launch).toHaveBeenCalledTimes(4);
    expect(chrome.launch.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({ headlessOverride: true, signal: expect.any(AbortSignal) }),
    );
    expect(state.profiles.get("openclaw")?.managedLaunchFailure).toBeUndefined();
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("reuses a pre-existing loopback browser after an initial short probe miss", async () => {
    const { profile, state } = setupEnsureBrowserAvailableHarness();
    state.resolved.ssrfPolicy = {};

    chrome.reachable.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    chrome.ready.mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(chrome.reachable).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:18800",
      PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
      undefined,
      expect.any(AbortSignal),
    );
    expect(chrome.reachable).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:18800",
      PROFILE_ATTACH_RETRY_TIMEOUT_MS,
      undefined,
      expect.any(AbortSignal),
    );
    expect(chrome.launch).not.toHaveBeenCalled();
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("explains attachOnly for externally managed loopback CDP services", async () => {
    const { profile } = setupEnsureBrowserAvailableHarness();

    chrome.reachable.mockResolvedValue(true);
    chrome.ready.mockResolvedValue(false);

    const promise = profile.ensureBrowserAvailable();
    await expect(promise).rejects.toThrow(
      'Port 18800 is in use for profile "openclaw" but not by openclaw.',
    );
    await expect(promise).rejects.toThrow(
      "set browser.profiles.openclaw.attachOnly=true so OpenClaw attaches without trying to manage the local process",
    );
    await expect(promise).rejects.toThrow(
      "For Browserless Docker, set EXTERNAL to the same WebSocket endpoint OpenClaw can reach via browser.profiles.<name>.cdpUrl.",
    );

    expect(chrome.launch).not.toHaveBeenCalled();
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("retries remote CDP websocket reachability once before failing", async () => {
    setupEnsureBrowserAvailableHarness();

    const state = makeBrowserServerState();
    state.resolved.profiles.openclaw = {
      cdpUrl: "ws://browserless:3001",
      color: "#00AA00",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profile = ctx.forProfile("openclaw");
    const expectedRemoteHttpTimeoutMs = state.resolved.remoteCdpTimeoutMs;
    const expectedRemoteWsTimeoutMs = state.resolved.remoteCdpHandshakeTimeoutMs;

    chrome.reachable.mockResolvedValueOnce(true);
    chrome.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(chrome.reachable).toHaveBeenCalledTimes(1);
    const probeArgs = [
      "ws://browserless:3001",
      expectedRemoteHttpTimeoutMs,
      expectedRemoteWsTimeoutMs,
      { allowPrivateNetwork: true, allowedHostnames: ["browserless"] },
      { signal: expect.any(AbortSignal) },
    ];
    expect(chrome.ready.mock.calls).toEqual([probeArgs, probeArgs]);
    expect(chrome.launch).not.toHaveBeenCalled();
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("resolves for attachOnly loopback profile with a bare ws:// cdpUrl when CDP is reachable (#68027)", async () => {
    setupEnsureBrowserAvailableHarness();

    const { profile, state } = createAttachOnlyLoopbackProfile("ws://127.0.0.1:9222");

    chrome.reachable.mockResolvedValueOnce(true);
    chrome.ready.mockResolvedValueOnce(true);

    await expect(profile.ensureBrowserAvailable()).resolves.toBeUndefined();

    expect(chrome.reachable).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      undefined,
      expect.any(AbortSignal),
    );
    expect(chrome.ready).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      state.resolved.remoteCdpHandshakeTimeoutMs,
      undefined,
      { signal: expect.any(AbortSignal), onDiagnostic: expect.any(Function) },
    );
    expect(chrome.launch).not.toHaveBeenCalled();
    expect(chrome.stop).not.toHaveBeenCalled();
  });

  it("caches external browser mode per observed browser instance", async () => {
    setupEnsureBrowserAvailableHarness();
    const { profile, state } = createAttachOnlyLoopbackProfile("http://127.0.0.1:9222");
    const emitDiagnostic =
      (wsUrl: string) =>
      async (...args: Parameters<typeof chromeModule.isChromeCdpReady>): Promise<boolean> => {
        await args[4]?.onDiagnostic?.({
          ok: true,
          cdpUrl: "http://127.0.0.1:9222",
          wsUrl,
          browser: "Chrome/151.0.0.0",
          elapsedMs: 1,
        });
        return true;
      };

    chrome.reachable.mockResolvedValue(true);
    chrome.ready
      .mockImplementationOnce(emitDiagnostic("ws://127.0.0.1:9222/devtools/browser/A"))
      .mockImplementationOnce(emitDiagnostic("ws://127.0.0.1:9222/devtools/browser/A"))
      .mockImplementationOnce(emitDiagnostic("ws://127.0.0.1:9222/devtools/browser/B"));
    chrome.inspectMode.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await profile.ensureBrowserAvailable();
    const runtime = state.profiles.get("manual-cdp");
    await expect(runtime?.externalBrowserMode?.headless).resolves.toBe(false);

    await profile.ensureBrowserAvailable();
    expect(chrome.inspectMode).toHaveBeenCalledTimes(1);

    await profile.ensureBrowserAvailable();
    await expect(runtime?.externalBrowserMode?.headless).resolves.toBe(true);
    expect(chrome.inspectMode).toHaveBeenCalledTimes(2);

    if (!runtime) {
      throw new Error("expected manual-cdp runtime");
    }
    await beginProfileTransition({ state, runtime, reason: "test browser mode cache reset" });
    expect(runtime.externalBrowserMode).toBeUndefined();
  });

  it("redacts credentials in remote CDP availability errors", async () => {
    setupEnsureBrowserAvailableHarness();

    const state = makeBrowserServerState({
      profile: {
        name: "remote",
        cdpUrl: "https://user:pass@browserless.example.com?token=supersecret123",
        cdpHost: "browserless.example.com",
        cdpIsLoopback: false,
        cdpPort: 443,
        color: "#00AA00",
        driver: "openclaw",
        headless: false,
        attachOnly: false,
      },
      resolvedOverrides: {
        defaultProfile: "remote",
        ssrfPolicy: {},
      },
    });
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profile = ctx.forProfile("remote");

    chrome.reachable.mockResolvedValue(false);

    const promise = profile.ensureBrowserAvailable();
    await expect(promise).rejects.toThrow(BrowserProfileUnavailableError);
    await expect(promise).rejects.toThrow(
      'Remote CDP for profile "remote" is not reachable at https://browserless.example.com/?token=***.',
    );

    expect(chrome.launch).not.toHaveBeenCalled();
    expect(chrome.stop).not.toHaveBeenCalled();
  });
});

function createAvailability() {
  const profile = makeBrowserProfile({ attachOnly: true });
  const state = makeBrowserServerState({ profile });
  const runtime: ProfileRuntimeState = { profile, running: null };
  state.profiles.set(profile.name, runtime);
  const availability = createProfileAvailability({
    opts: { getState: () => state },
    profile,
    state: () => state,
    runtime,
  });
  vi.mocked(chromeModule.isChromeCdpReady).mockImplementation(async (...args) => {
    await args[4]?.onDiagnostic?.({
      ok: true,
      cdpUrl: profile.cdpUrl,
      wsUrl: "ws://127.0.0.1:18800/devtools/browser/synthetic",
      elapsedMs: 1,
    });
    return true;
  });
  return { availability, runtime, state };
}

describe("external browser mode availability", () => {
  it("observes the mode again on the next request after an inconclusive inspection", async () => {
    const { availability, runtime } = createAvailability();
    vi.mocked(chromeModule.inspectLocalChromeHeadlessMode)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(false);

    await expect(availability.isReachable()).resolves.toBe(true);
    await expect(availability.isReachable()).resolves.toBe(true);
    await expect(runtime.externalBrowserMode?.headless).resolves.toBe(false);
    expect(chromeModule.inspectLocalChromeHeadlessMode).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared observation alive when its first caller cancels", async () => {
    const { availability, runtime } = createAvailability();
    const observation = Promise.withResolvers<boolean>();
    const observing = Promise.withResolvers<AbortSignal | undefined>();
    vi.mocked(chromeModule.inspectLocalChromeHeadlessMode).mockImplementation(({ signal }) => {
      observing.resolve(signal);
      return observation.promise;
    });
    const caller = new AbortController();
    const first = availability.isReachable(undefined, { signal: caller.signal });
    const rejected = expect(first).rejects.toThrow("cancel first caller");
    const ownerSignal = await observing.promise;
    const secondReady = vi.fn();
    const second = availability.isReachable().then(secondReady);
    await setImmediate();
    expect(secondReady).not.toHaveBeenCalled();
    caller.abort(new Error("cancel first caller"));
    await rejected;
    expect(ownerSignal?.aborted).toBe(false);

    observation.resolve(false);
    await second;
    expect(secondReady).toHaveBeenCalledWith(true);
    await expect(runtime.externalBrowserMode?.headless).resolves.toBe(false);
    expect(chromeModule.inspectLocalChromeHeadlessMode).toHaveBeenCalledTimes(1);
  });

  it("aborts the observation and clears its cache on a profile transition", async () => {
    const { availability, runtime, state } = createAvailability();
    const observing = Promise.withResolvers<void>();
    vi.mocked(chromeModule.inspectLocalChromeHeadlessMode).mockImplementation(({ signal }) => {
      observing.resolve();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("mode observation aborted", { cause: signal.reason })),
          { once: true },
        );
      });
    });
    const pending = availability.isReachable();
    const rejected = expect(pending).rejects.toThrow("mode observation aborted");
    await observing.promise;
    await beginProfileTransition({
      state,
      runtime,
      reason: "test transition",
      closeSharedAdapters: false,
    });
    await rejected;
    expect(runtime.externalBrowserMode).toBeUndefined();
  });
});
