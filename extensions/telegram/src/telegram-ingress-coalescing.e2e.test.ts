// Telegram ingress coalescing regression: durable queue → core drain → grammY → inbound buffer.
// Both Telegram inbound buffers (album, forward-burst debounce) defer their spooled
// participant the same way, so both depend on deferredLaneOccupancy="release" to admit
// later same-lane members. Cover them together — a lane regression breaks both at once.
import path from "node:path";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdTelegramMediaTimeouts,
  resolveFlushTimerForDelay,
} from "./bot-media-timers.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { runTelegramChannelInboundEventWithHarness } from "./bot.test-helpers.js";
import type {
  TelegramIngressMonitorOptions,
  TelegramIngressResources,
} from "./telegram-ingress-coalescing-fixture.test-support.js";
import {
  createBotApiTransport,
  holdForwardWindow,
  photoUpdate,
  forwardedPhotoUpdate,
  forwardedTextUpdate,
  textUpdate,
} from "./telegram-ingress-coalescing.test-support.js";

const downstreamTurns = vi.hoisted(() =>
  vi.fn(
    async (
      _ctx: MsgContext,
      _abortSignal?: AbortSignal,
      _turnAdoptionLifecycle?: GetReplyOptions["turnAdoptionLifecycle"],
    ) => ({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    }),
  ),
);
const inboundTurns = vi.hoisted(() => ({
  active: new Set<Promise<void>>(),
  gate: undefined as (() => Promise<void>) | undefined,
}));
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-album-ingress-");
const saveRemoteMedia = vi.hoisted(() =>
  vi.fn(async (params: { filePathHint?: string }) => ({
    id: path.basename(params.filePathHint ?? "photo"),
    path: `/tmp/${path.basename(params.filePathHint ?? "photo.jpg")}`,
    size: 4,
    contentType: "image/jpeg",
  })),
);

vi.mock("./fetch.js", () => ({
  resolveTelegramApiBase: (apiRoot?: string) => apiRoot ?? "https://api.telegram.org",
  resolveTelegramFetch: (proxyFetch?: typeof fetch) => proxyFetch ?? globalThis.fetch,
  resolveTelegramTransport: (proxyFetch?: typeof fetch) => {
    const fetchImpl = proxyFetch ?? globalThis.fetch;
    return { fetch: fetchImpl, sourceFetch: fetchImpl, close: async () => {} };
  },
  shouldRetryTelegramTransportFallback: () => false,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      const turn = (async () => {
        await inboundTurns.gate?.();
        return await runTelegramChannelInboundEventWithHarness(
          actual,
          params,
          async (dispatchParams) => {
            return await downstreamTurns(
              dispatchParams.ctx,
              dispatchParams.replyOptions?.abortSignal,
              dispatchParams.replyOptions?.turnAdoptionLifecycle,
            );
          },
        );
      })();
      const settled = turn.then(
        () => {},
        () => {},
      );
      inboundTurns.active.add(settled);
      void settled.then(() => {
        inboundTurns.active.delete(settled);
      });
      return await turn;
    },
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    saveRemoteMedia,
  };
});

vi.mock("./bot-handlers.agent.runtime.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
}));

vi.mock("./bot-message-dispatch.agent.runtime.js", () => ({
  findModelInCatalog: vi.fn(() => undefined),
  loadPreparedModelCatalog: vi.fn(async () => []),
  modelSupportsVision: vi.fn(() => false),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

// Preserve production initialization order before the fixture imports those modules.
await import("./bot.js");
await import("openclaw/plugin-sdk/reply-runtime");
await import("./telegram-ingress-drain-factory.js");
await import("./runtime.js");
await import("./runtime.test-support.js");
const ingressSpool = await import("./telegram-ingress-spool.js");
const { openTelegramIngressQueue, telegramQueueEventId } = ingressSpool;
const { writeTelegramSpooledUpdate } = await import("./telegram-ingress-spool.test-support.js");
const messageDispatchDedupe = await import("./message-dispatch-dedupe.js");
const processingOutcome = await import("./bot-processing-outcome.js");
const {
  admitAlbum,
  assertSpoolTombstoned,
  createDownstreamTurnFixture,
  createIngressMonitor,
  flushHeldQuietWindow,
  interceptReplayGuard,
  resetTelegramIngressRuntime,
  runtimeErrors,
  releaseIngressCase,
  useIngressTimers,
} = await import("./telegram-ingress-coalescing-fixture.test-support.js");
const { captureNextDownstreamTurn, awaitSingleDownstreamTurn, holdDownstreamLane } =
  createDownstreamTurnFixture(downstreamTurns);

describe("Telegram durable ingress coalescing", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
  let activeResources: TelegramIngressResources[];
  let cleanups: Array<() => unknown>;

  beforeEach(async () => {
    stateDir = sessionDirs.make();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    activeResources = [];
    cleanups = [];
    inboundTurns.gate = undefined;
    runtimeErrors.length = 0;
    downstreamTurns
      .mockReset()
      .mockResolvedValue({ queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } });
    saveRemoteMedia.mockReset();
    resetTelegramIngressRuntime();
  });

  async function releaseCaseState() {
    await releaseIngressCase(activeResources, inboundTurns.active, stateDir);
  }

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    vi.useRealTimers();
    await releaseCaseState();
    vi.restoreAllMocks();
    resetPluginStateStoreForTests({ closeDatabase: false });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  async function createMonitor(options: TelegramIngressMonitorOptions = {}) {
    const resources = await createIngressMonitor(stateDir, options);
    activeResources.push(resources);
    return resources;
  }

  const getQueue = () => openTelegramIngressQueue({ stateDir });
  const tombstones = (...updateIds: number[]) => assertSpoolTombstoned({ stateDir, updateIds });
  const onCleanup = (cleanup: () => unknown) => cleanups.push(cleanup);
  const expectBodies = (...bodies: string[]) =>
    expect(downstreamTurns.mock.calls.map(([turn]) => turn.RawBody)).toEqual(bodies);
  function holdQuietWindow(delay: number) {
    const timers = holdTelegramMediaTimeouts(delay);
    onCleanup(() => timers.mockRestore());
    return timers;
  }
  function operationGate() {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    onCleanup(() => release.resolve());
    return {
      entered: entered.promise,
      release: () => release.resolve(),
      hold: async () => {
        entered.resolve();
        await release.promise;
      },
    };
  }
  async function spool(...updates: Parameters<typeof writeTelegramSpooledUpdate>[0]["update"][]) {
    for (const update of updates) {
      await writeTelegramSpooledUpdate({ stateDir, update });
    }
  }
  async function expectPending(...rows: unknown[]) {
    expect(await getQueue().listPending({ limit: "all" })).toMatchObject(rows);
  }
  async function expectPendingIds(ids: number[], fields: Record<string, unknown> = {}) {
    await expectPending(...ids.map((id) => ({ id: telegramQueueEventId(id), ...fields })));
  }
  async function expectReleased() {
    expect(await getQueue().listClaims()).toEqual([]);
    expect(await getQueue().listFailed?.({ limit: "all" })).toEqual([]);
  }
  async function expectReplayKeys(
    recent: boolean,
    updates: Array<ReturnType<typeof textUpdate> | ReturnType<typeof forwardedPhotoUpdate>>,
    guard = messageDispatchDedupe.createTelegramMessageDispatchReplayGuard(),
  ) {
    for (const update of updates) {
      expect(
        await guard.hasRecent({
          accountId: "default",
          botUserId: telegramBotInfoForTest.id,
          msg: update.message,
        }),
      ).toBe(recent);
    }
  }
  async function bufferBeforeBacklog(
    first: { update_id: number },
    second: { update_id: number },
    delay = 40,
  ) {
    const { monitor } = await createMonitor();
    vi.useFakeTimers({ toFake: ["performance"] });
    const timers = holdQuietWindow(delay);
    const dispatched = captureNextDownstreamTurn();
    monitor.start();
    await monitor.admit(first);
    await monitor.waitForIdle();
    await monitor.pause();
    await spool(second);
    await expectPendingIds([second.update_id]);
    return { monitor, timers, dispatched };
  }

  it("keeps a timed-out update retryable while its original middleware is still waiting", async ({
    signal,
  }) => {
    const wait = <T>(work: Promise<T>) => withinTest(work, signal);
    // The monitor captures Date.now at construction, so install the clock first.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const blockerGate = operationGate();
    downstreamTurns.mockImplementationOnce(async () => {
      await blockerGate.hold();
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    const { monitor, bot } = await createMonitor({
      adoptionStallTimeoutMs: 300_000,
      pollIntervalMs: 60_000,
      onRuntimeError: vi.fn(),
    });
    const blocker = bot.handleUpdate(
      textUpdate({ updateId: 801, messageId: 1, text: "busy turn" }),
    );
    onCleanup(() => blocker);
    await wait(blockerGate.entered);
    const handleUpdate = vi.spyOn(bot, "handleUpdate");
    const queued = textUpdate({ updateId: 802, messageId: 2, text: "deliver this later" });
    const tail = textUpdate({ updateId: 803, messageId: 3, text: "deliver after the retry" });
    const eventId = telegramQueueEventId(802);
    const queue = openTelegramIngressQueue({ stateDir });
    monitor.start();

    await wait(monitor.admit(queued));
    await wait(vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledTimes(1)));
    await wait(vi.advanceTimersByTimeAsync(300_000));
    await wait(
      vi.waitFor(async () => {
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: eventId, attempts: 1, lastError: expect.stringContaining("handler-timeout") },
        ]);
      }),
    );

    await wait(monitor.admit(tail));
    await wait(vi.advanceTimersByTimeAsync(1_000));
    monitor.requestDrain();
    await wait(
      vi.waitFor(() => {
        expect(handleUpdate.mock.calls.filter(([update]) => update.update_id === 802)).toHaveLength(
          2,
        );
      }),
    );
    // A pending duplicate must not let its same-lane follower overtake it.
    await wait(
      vi.waitFor(async () => {
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: eventId, attempts: 2, payload: { update: queued } },
          { id: telegramQueueEventId(803), attempts: 0 },
        ]);
      }),
    );
    expect(downstreamTurns).toHaveBeenCalledTimes(1);

    blockerGate.release();
    await blocker;
    await monitor.waitForIdle();
    await vi.advanceTimersByTimeAsync(2_000);
    monitor.requestDrain();
    await monitor.waitForIdle();
    expect(downstreamTurns).toHaveBeenCalledTimes(3);
    expectBodies("busy turn", "deliver this later", "deliver after the retry");
    await tombstones(802, 803);
    const duplicate = await processingOutcome.runWithTelegramUpdateProcessingFrame(() =>
      bot.handleUpdate(queued),
    );
    expect(duplicate.result).toEqual({ kind: "skipped" });
    expect(downstreamTurns).toHaveBeenCalledTimes(3);
  });

  it("coalesces album members admitted across separate drain passes", async () => {
    const albumTimers = holdQuietWindow(40);
    const { monitor } = await createMonitor();
    const first = photoUpdate({ updateId: 101, messageId: 1, caption: "Two photo album" });
    const second = photoUpdate({ updateId: 102, messageId: 2 });
    monitor.start();
    await monitor.admit(first);
    await monitor.waitForIdle();
    await monitor.admit(second);
    await monitor.waitForIdle();
    flushHeldQuietWindow(albumTimers, 40);
    await monitor.waitForDeferredClaims();
    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("Two photo album");
    expect(turn.media).toMatchObject([
      { path: "/tmp/photo-1.jpg", kind: "image" },
      { path: "/tmp/photo-2.jpg", kind: "image" },
    ]);
    await tombstones(101, 102);
  });

  it("keeps a later album alive and ordered behind a slowly adopting album", async ({ signal }) => {
    const wait = <T>(work: Promise<T>) => withinTest(work, signal);
    const { monitor } = await createMonitor({ adoptionStallTimeoutMs: 1_000 });
    const {
      turnsDeferred: [headDispatched],
      releaseHead,
    } = holdDownstreamLane(true);
    onCleanup(() => releaseHead.resolve());
    useIngressTimers();
    monitor.start();
    await wait(admitAlbum(monitor, "A", 1_001));
    // Freeze the claim clock while dispatch finishes its real worker I/O.
    await wait(headDispatched.promise);
    await wait(admitAlbum(monitor, "B", 1_003));
    await wait(vi.advanceTimersByTimeAsync(3_000));
    expect(downstreamTurns, "Album B must wait for album A's adoption").toHaveBeenCalledOnce();
    releaseHead.resolve();
    await wait(monitor.waitForDeferredClaims());
    expect(downstreamTurns).toHaveBeenCalledTimes(2);
    expectBodies("Album A", "Album B");
    await tombstones(1_001, 1_002, 1_003, 1_004);
    expect(runtimeErrors).toEqual([]);
  });

  it("keeps a later same-sender forward batch alive behind a deferred batch", async ({
    signal,
  }) => {
    const wait = <T>(work: Promise<T>) => withinTest(work, signal);
    const { monitor } = await createMonitor({ adoptionStallTimeoutMs: 3_000 });
    const { releaseHead, turnsDeferred } = holdDownstreamLane();
    onCleanup(() => releaseHead.resolve());
    useIngressTimers();
    monitor.start();
    await wait(
      monitor.admit(forwardedTextUpdate({ updateId: 1_401, messageId: 1, text: "Batch A" })),
    );
    await wait(monitor.waitForIdle());
    await wait(vi.advanceTimersByTimeAsync(1_000));
    // Freeze the claim clock while each flushed turn finishes its real worker I/O.
    await wait(turnsDeferred[0].promise);
    await wait(
      monitor.admit(forwardedTextUpdate({ updateId: 1_402, messageId: 2, text: "Batch B" })),
    );
    await wait(monitor.waitForIdle());
    await wait(vi.advanceTimersByTimeAsync(1_000));
    // A deferred head releases the sender key; B queues behind it in the session lane.
    await wait(turnsDeferred[1].promise);
    await wait(vi.advanceTimersByTimeAsync(9_000));
    const queue = openTelegramIngressQueue({ stateDir });
    expect(await wait(queue.listPending({ limit: "all" })), "Batch B stalled behind A").toEqual([]);
    expect(
      (await wait(queue.listClaims())).map(({ id, attempts }) => ({
        id,
        attempts,
      })),
    ).toEqual([
      { id: telegramQueueEventId(1_401), attempts: 0 },
      { id: telegramQueueEventId(1_402), attempts: 0 },
    ]);
    releaseHead.resolve();
    await wait(monitor.waitForDeferredClaims());
    expectBodies("Batch A", "Batch B");
    await tombstones(1_401, 1_402);
    expect(runtimeErrors).toEqual([]);
  });

  it("releases later albums when the album ahead of it stops making progress", async () => {
    const download = operationGate();
    const headFinished = createDeferred<void>();
    const transport = createBotApiTransport();
    let fetchHeld = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.includes("/getFile") && !fetchHeld) {
        fetchHeld = true;
        // Deliberately ignore init.signal: claim settlement must release the queue.
        await download.hold();
        throw new Error("released stuck album download");
      }
      return await transport.fetch(input, init);
    };
    const { monitor } = await createMonitor({
      adoptionStallTimeoutMs: 1_000,
      telegramTransport: { ...transport, fetch: fetchImpl, sourceFetch: fetchImpl },
      onRuntimeError: () => headFinished.resolve(),
    });
    const followerDispatched = captureNextDownstreamTurn();
    onCleanup(() => headFinished.promise);
    useIngressTimers();
    monitor.start();
    await admitAlbum(monitor, "A", 1_101);
    await download.entered;
    await admitAlbum(monitor, "B", 1_103);
    expect(downstreamTurns).not.toHaveBeenCalled();
    // Observe this attempt's disposition without the monitor reclaiming retryable rows.
    await monitor.pause();
    await vi.advanceTimersByTimeAsync(1_000);
    // B's dispatch needs worker I/O after A's claims settle; keep time frozen.
    await followerDispatched;
    await monitor.waitForDeferredClaims();
    expect(downstreamTurns).toHaveBeenCalledOnce();
    expect(downstreamTurns.mock.calls[0]?.[0].RawBody).toBe("Album B");
    const queue = openTelegramIngressQueue({ stateDir });
    await expectReleased();
    await expectPendingIds([1_101, 1_102], {
      attempts: 1,
      lastError: expect.stringContaining("handler-timeout"),
    });
    for (const updateId of [1_101, 1_102, 1_103, 1_104]) {
      await expect(
        queue.enqueue(telegramQueueEventId(updateId), {} as never),
      ).resolves.toMatchObject({
        kind: updateId < 1_103 ? "pending" : "completed",
      });
    }
  });

  it("keeps every album member claimed while durable adoption commit is held", async () => {
    const commitGate = operationGate();
    const replay = interceptReplayGuard({
      commit: async (count, commit) => {
        if (count === 1) {
          await commitGate.hold();
        }
        return await commit();
      },
    });
    const { monitor } = await createMonitor({
      adoptionStallTimeoutMs: 1_000,
      onRuntimeError: (error) => runtimeErrors.push(error),
    });
    useIngressTimers();
    onCleanup(() => Promise.allSettled(replay.settlements));
    monitor.start();
    await admitAlbum(monitor, "A", 1_201);
    // The normal downstream return starts durable finalization without turn heartbeats.
    await commitGate.entered;
    await vi.advanceTimersByTimeAsync(3_000);
    commitGate.release();
    await Promise.all(replay.settlements);
    await monitor.waitForDeferredClaims();
    expect(downstreamTurns).toHaveBeenCalledOnce();
    await tombstones(1_201, 1_202);
    expect(runtimeErrors).toEqual([]);
  });

  it("dispatches interleaved albums in first-member arrival order", async () => {
    const { monitor } = await createMonitor();
    useIngressTimers();
    monitor.start();
    for (const [index, name] of ["A", "B", "A"].entries()) {
      const update = photoUpdate({
        updateId: 1_301 + index,
        messageId: 1_301 + index,
        ...(index < 2 ? { caption: `Album ${name}` } : {}),
      });
      update.message.media_group_id = `album-${name}`;
      await monitor.admit(update);
      await monitor.waitForIdle();
      if (index < 2) {
        await vi.advanceTimersByTimeAsync(10);
      }
    }
    // B closes at 50 ms; A's last member moves its close to 60 ms.
    await vi.advanceTimersByTimeAsync(40);
    await monitor.waitForDeferredClaims();
    expect(downstreamTurns).toHaveBeenCalledTimes(2);
    expectBodies("Album A", "Album B");
    expect(downstreamTurns.mock.calls.map(([turn]) => turn.media?.length)).toEqual([2, 1]);
    await tombstones(1_301, 1_302, 1_303);
    expect(runtimeErrors).toEqual([]);
  });

  it.each([
    {
      buffer: "album",
      delayMs: 40,
      first: photoUpdate({ updateId: 1_101, messageId: 1, caption: "Buffered context" }),
      second: photoUpdate({ updateId: 1_102, messageId: 2 }),
      media: [
        { path: "/tmp/photo-1.jpg", kind: "image" },
        { path: "/tmp/photo-2.jpg", kind: "image" },
      ],
    },
    {
      buffer: "forward",
      delayMs: 1_000,
      first: forwardedTextUpdate({ updateId: 1_201, messageId: 1, text: "Buffered context" }),
      second: forwardedPhotoUpdate({ updateId: 1_202, messageId: 2 }),
      media: [{ path: "/tmp/photo-1.jpg", kind: "image" }],
    },
  ])("holds the $buffer quiet flush while the next member is durably pending", async (testCase) => {
    // Pause the pump, not durable admission: the next member has not reached the buffer.
    const {
      monitor,
      timers: quietTimers,
      dispatched,
    } = await bufferBeforeBacklog(testCase.first, testCase.second, testCase.delayMs);
    const held = createDeferred<void>();
    const scheduleHeldTimer = quietTimers.getMockImplementation();
    if (!scheduleHeldTimer) {
      throw new Error("Expected the held quiet-timer implementation");
    }
    quietTimers.mockImplementation((callback, delay, ...args) => {
      const timer = scheduleHeldTimer(callback, delay, ...args);
      if (delay === testCase.delayMs) {
        held.resolve();
      }
      return timer;
    });
    flushHeldQuietWindow(quietTimers, testCase.delayMs);
    expect(
      await Promise.race([held.promise.then(() => "held"), dispatched.then(() => "dispatched")]),
    ).toBe("held");
    quietTimers.mockImplementation(scheduleHeldTimer);
    expect(downstreamTurns).not.toHaveBeenCalled();

    monitor.start();
    await monitor.waitForIdle();
    flushHeldQuietWindow(quietTimers, testCase.delayMs);
    const turn = await dispatched;
    await monitor.waitForDeferredClaims();
    expect(downstreamTurns).toHaveBeenCalledOnce();
    expect(turn.Body).toContain("Buffered context");
    expect(turn).toMatchObject({ media: testCase.media });
    await tombstones(testCase.first.update_id, testCase.second.update_id);
  });

  it.each([
    { readState: "pending", holdBeforeDeadline: false },
    { readState: "holding just before the deadline", holdBeforeDeadline: true },
  ])("flushes the album at its deadline with a $readState backlog read", async (testCase) => {
    const queue = openTelegramIngressQueue({ stateDir });
    const openQueue = vi.spyOn(ingressSpool, "openTelegramIngressQueue").mockReturnValue(queue);
    const read = operationGate();
    const {
      monitor,
      timers: albumTimers,
      dispatched,
    } = await bufferBeforeBacklog(
      photoUpdate({ updateId: 1_401, messageId: 1, caption: "Deadline photo album" }),
      photoUpdate({ updateId: 1_402, messageId: 2 }),
    );
    onCleanup(() => openQueue.mockRestore());
    const listUnsettled = queue.listUnsettled?.bind(queue);
    if (!listUnsettled) {
      throw new Error("Expected the ingress queue's coherent backlog reader");
    }
    vi.spyOn(queue, "listUnsettled").mockImplementationOnce(async (options) => {
      const rows = await listUnsettled(options);
      await read.hold();
      return rows;
    });
    const quietFlush = resolveFlushTimerForDelay(albumTimers, 40);
    if (!quietFlush) {
      throw new Error("Expected the buffered album's quiet timer");
    }
    albumTimers.mockRestore();
    vi.useFakeTimers({
      toFake: ["performance", "setTimeout", "clearTimeout"],
      shouldClearNativeTimers: true,
    });
    vi.advanceTimersByTime(40);
    quietFlush();
    await read.entered;

    await vi.advanceTimersByTimeAsync(19_959);
    if (testCase.holdBeforeDeadline) {
      read.release();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(downstreamTurns).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    const turn = await dispatched;
    await monitor.waitForDeferredClaims();
    expect(turn.Body).toContain("Deadline photo album");
    expect(turn).toMatchObject({ media: [{ path: "/tmp/photo-1.jpg", kind: "image" }] });

    read.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(downstreamTurns).toHaveBeenCalledOnce();
    await expectPendingIds([1_402]);
  });

  it("flushes an album while unrelated plain text is durably pending on the same lane", async () => {
    const {
      monitor,
      timers: albumTimers,
      dispatched,
    } = await bufferBeforeBacklog(
      photoUpdate({ updateId: 1_301, messageId: 1, caption: "Single photo album" }),
      textUpdate({ updateId: 1_302, messageId: 2, text: "Unrelated plain text" }),
    );

    flushHeldQuietWindow(albumTimers, 40);
    const turn = await dispatched;
    await monitor.waitForDeferredClaims();
    expect(downstreamTurns).toHaveBeenCalledOnce();
    expect(turn.Body).toContain("Single photo album");
    expect(turn).toMatchObject({ media: [{ path: "/tmp/photo-1.jpg", kind: "image" }] });
    await expectPendingIds([1_302]);

    monitor.start();
    await monitor.waitForIdle();
    expect(downstreamTurns).toHaveBeenCalledTimes(2);
    expect(downstreamTurns.mock.calls[1]?.[0].Body).toContain("Unrelated plain text");
    await tombstones(1_301, 1_302);
  });

  it.each(["commit", "rollback"] as const)(
    "joins a buffered adoption %s before monitor stop returns",
    async (phase) => {
      const operation = operationGate();
      const createGuard = messageDispatchDedupe.createTelegramMessageDispatchReplayGuard;
      const replay = interceptReplayGuard({
        commit: async (count, commit) => {
          if (phase === "commit" && count === 1) {
            await operation.hold();
            return await commit();
          }
          if (phase === "rollback" && count === 2) {
            await commit();
            throw new Error("synthetic second-key commit failure");
          }
          return await commit();
        },
        forget: async (forget) => {
          if (phase === "rollback") {
            await operation.hold();
          }
          return await forget();
        },
      });
      let stopping: Promise<void> | undefined;
      try {
        await spool(
          forwardedTextUpdate({ updateId: 901, messageId: 1, text: "First note" }),
          forwardedTextUpdate({ updateId: 902, messageId: 2, text: "Second note" }),
        );
        const { monitor } = await createMonitor({ onRuntimeError: vi.fn() });
        monitor.start();
        await operation.entered;
        let stopped = false;
        stopping = monitor.stop().then(() => {
          stopped = true;
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        expect(stopped).toBe(false);
      } finally {
        operation.release();
        await Promise.allSettled(replay.settlements);
        await stopping;
        replay.restore();
      }
      const queue = openTelegramIngressQueue({ stateDir });
      expect(await queue.listClaims()).toEqual([]);
      if (phase === "commit") {
        await tombstones(901, 902);
      } else {
        await expectPendingIds([901, 902], { attempts: 0 });
      }
      await expectReplayKeys(
        phase === "commit",
        [1, 2].map((messageId) =>
          forwardedTextUpdate({ updateId: 900 + messageId, messageId, text: "note" }),
        ),
        createGuard(),
      );
    },
  );

  it("settles a never-adopted buffered participant when monitor stop aborts its owner", async () => {
    const buffered = createDeferred<void>();
    const createParticipant = processingOutcome.createTelegramSpooledReplayParticipant;
    vi.spyOn(processingOutcome, "createTelegramSpooledReplayParticipant").mockImplementation(
      (key) => {
        const participant = createParticipant(key);
        buffered.resolve();
        return participant;
      },
    );
    const { monitor } = await createMonitor({ onRuntimeError: vi.fn() });
    monitor.start();
    await monitor.admit(textUpdate({ updateId: 903, messageId: 3, text: "long ".repeat(810) }));
    await buffered.promise;
    await monitor.stop();
    expect(downstreamTurns).not.toHaveBeenCalled();
    await expectReleased();
    await expectPendingIds([903], { attempts: 0 });
  });

  it("coalesces a forwarded burst whose members arrive in separate getUpdates responses", async () => {
    const { monitor } = await createMonitor();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    monitor.start();
    await monitor.admit(forwardedTextUpdate({ updateId: 301, messageId: 1, text: "First note" }));
    await monitor.waitForIdle();
    // Live Test Server bursts delivered the photo member up to 790 ms after the text.
    await vi.advanceTimersByTimeAsync(790);
    await monitor.admit(forwardedPhotoUpdate({ updateId: 302, messageId: 2 }));
    await monitor.waitForIdle();
    expect(downstreamTurns).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    const turn = await awaitSingleDownstreamTurn();
    expect(turn.Body).toContain("First note");
    expect(turn.media).toMatchObject([{ path: "/tmp/photo-1.jpg", kind: "image" }]);
    await monitor.waitForDeferredClaims();
    expect(downstreamTurns).toHaveBeenCalledOnce();
    await tombstones(301, 302);
  });

  it("dispatches sustained forwarded messages before their ingress stream falls quiet", async () => {
    const { monitor } = await createMonitor();
    const messageCount = 24;
    const updateIds = Array.from({ length: messageCount }, (_, index) => 501 + index);
    const firstDispatch = captureNextDownstreamTurn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    monitor.start();

    for (let index = 0; index < messageCount; index += 1) {
      await monitor.admit(
        forwardedTextUpdate({
          updateId: 501 + index,
          messageId: index + 1,
          text: `sustained-forward-${String(index).padStart(2, "0")}`,
        }),
      );
      // Durable admission can precede buffer entry while the handler hydrates state.
      await monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(250);
      if (index === 19) {
        // Hold the 5 s clock boundary while the flushed turn finishes real I/O.
        await firstDispatch;
        expect(downstreamTurns.mock.calls.length).toBeGreaterThan(0);
      }
    }

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(
      () => {
        const deliveredMessageIds = downstreamTurns.mock.calls.flatMap(([context]) => {
          const turn = context as MsgContext;
          return Array.from(
            (turn.BodyForAgent ?? turn.Body ?? "").matchAll(/sustained-forward-(\d{2})/g),
            (match) => match[1],
          );
        });
        expect(deliveredMessageIds).toEqual(
          Array.from({ length: messageCount }, (_, index) => String(index).padStart(2, "0")),
        );
      },
      { timeout: 5_000, interval: 5 },
    );
    await monitor.waitForDeferredClaims();
    await tombstones(...updateIds);
  });

  it("keeps a forwarded burst pending when its deferred attachment download fails transiently", async () => {
    const downloadError = new MediaFetchError("http_error", "Telegram file download HTTP 502", {
      status: 502,
    });
    saveRemoteMedia.mockRejectedValueOnce(downloadError);
    await spool(
      forwardedTextUpdate({ updateId: 601, messageId: 1, text: "Forwarded context" }),
      forwardedPhotoUpdate({ updateId: 602, messageId: 2 }),
    );
    const { monitor } = await createMonitor({ onRuntimeError: vi.fn() });
    const forwardWindow = holdForwardWindow();

    try {
      monitor.start();
      await monitor.waitForIdle();
      // Both members are buffered before either attachment downloads.
      expect(saveRemoteMedia).not.toHaveBeenCalled();
      forwardWindow.flush();
      await monitor.waitForDeferredClaims();
    } finally {
      forwardWindow.restore();
      await monitor.stop();
    }

    expect(saveRemoteMedia).toHaveBeenCalledOnce();
    expect(downstreamTurns).not.toHaveBeenCalled();
    await expectReleased();
    await expectPendingIds([601, 602], { attempts: 1, lastError: downloadError.message });
    // Released dispatch claims let the replay process both messages again.
    await expectReplayKeys(false, [
      forwardedTextUpdate({ updateId: 601, messageId: 1, text: "Forwarded context" }),
      forwardedPhotoUpdate({ updateId: 602, messageId: 2 }),
    ]);
  });

  it("keeps a text update pending when shutdown aborts the turn before adoption", async () => {
    const update = textUpdate({ updateId: 901, messageId: 1, text: "interrupted by restart" });
    const eventId = telegramQueueEventId(update.update_id);
    await spool(update);
    const queue = getQueue();
    downstreamTurns.mockImplementationOnce(async (_ctx, abortSignal) => {
      if (!abortSignal) {
        throw new Error("Expected the turn's abort signal");
      }
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) {
          resolve();
        } else {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    const { monitor } = await createMonitor();
    monitor.start();
    await awaitSingleDownstreamTurn();
    await monitor.stop();
    await vi.waitFor(async () => {
      expect(await queue.listClaims()).toEqual([]);
      await expectPending({ id: eventId, attempts: 0 });
    });
    const replay = await queue.enqueue(eventId, {
      version: 1,
      updateId: update.update_id,
      receivedAt: Date.now(),
      update,
    });
    expect(replay.kind).not.toBe("completed");
  });

  it("joins a turn that resumes after shutdown before releasing its state directory", async () => {
    const update = textUpdate({ updateId: 904, messageId: 4, text: "resumed after shutdown" });
    await spool(update);
    const turn = operationGate();
    inboundTurns.gate = turn.hold;
    const { monitor } = await createMonitor({
      onRuntimeError: (error) => runtimeErrors.push(error),
    });
    monitor.start();
    await turn.entered;
    // Hold the maintenance the resumed write kicks so case release must retire it.
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    await monitor.stop();
    const queue = openTelegramIngressQueue({ stateDir });
    await expectPendingIds([update.update_id], { attempts: 0 });
    expect(await queue.listClaims()).toEqual([]);

    // A loaded host reaches the session write only after shutdown returned.
    turn.release();
    await releaseCaseState();

    expect(downstreamTurns).toHaveBeenCalledOnce();
    expect(downstreamTurns.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(runtimeErrors).toEqual([]);
  });

  it("bounds repeated session-start conflicts and drains the next Telegram update", async () => {
    const poison = textUpdate({ updateId: 801, messageId: 1, text: "poison" });
    const after = textUpdate({ updateId: 802, messageId: 2, text: "after" });
    const poisonId = telegramQueueEventId(poison.update_id);
    const sessionError = Object.assign(
      new Error('Session "agent:main:telegram:direct:111" changed while starting work. Retry.'),
      { code: "SESSION_WORK_START_CHANGED" },
    );
    downstreamTurns.mockImplementation(async (turn) => {
      if ((turn.BodyForAgent ?? turn.Body ?? "").includes("poison")) {
        throw sessionError;
      }
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    await spool(poison, after);
    const queue = openTelegramIngressQueue({ stateDir });
    for (let attempt = 1; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
      const claim = await queue.claim(poisonId, { ownerId: `proof:${attempt}` });
      if (!claim) {
        throw new Error(`Expected setup claim ${attempt}`);
      }
      await queue.release(claim, {
        lastError: sessionError.message,
        releasedAt: Date.now() - 60 * 60 * 1_000,
      });
    }
    const runtimeError = vi.fn();
    const { monitor } = await createMonitor({ onRuntimeError: runtimeError });

    monitor.start();
    await monitor.waitForIdle();
    expect(await queue.listFailed?.({ limit: "all" })).toEqual([
      expect.objectContaining({ id: poisonId, reason: "session-start-conflict-retry-limit" }),
    ]);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(
      downstreamTurns.mock.calls.some(([turn]) =>
        (turn.BodyForAgent ?? turn.Body ?? "").includes("after"),
      ),
    ).toBe(true);
  });
});
