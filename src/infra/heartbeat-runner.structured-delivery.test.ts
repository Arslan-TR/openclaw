import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import * as promises from "../../test/helpers/promise.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { InternalGetReplyFromConfig } from "../auto-reply/reply/get-reply.types.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import * as sessions from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as hooks from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import * as speech from "../tts/tts-runtime.test-support.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import * as heartbeatOutcomeStore from "./heartbeat-outcome-store.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { isRetryableHeartbeatSkipReason } from "./heartbeat-wake.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

// mock-isolation: Keep speech policy and synthesis real while isolating live guards and audio persistence.
vi.mock("../tts/tts.runtime.js", async () => {
  const { maybeApplyTtsToPayloadCore } = await import("../tts/tts-payload.js");
  return {
    maybeApplyTtsToPayload: (params: Parameters<typeof maybeApplyTtsToPayloadCore>[0]) =>
      maybeApplyTtsToPayloadCore(params, async () => "https://example.test/heartbeat.ogg"),
  };
});

installHeartbeatRunnerTestRuntime();
const TELEGRAM_GROUP = "-1001234567890";
type RunOptions = Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps">;
type Sandbox = Parameters<Parameters<typeof withTempTelegramHeartbeatSandbox>[0]>[0];
function createCase({ tmpDir, storePath, replySpy }: Sandbox) {
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "telegram" } } },
    messages: { visibleReplies: "automatic" },
    channels: {
      telegram: { botToken: "test-token", allowFrom: ["*"], heartbeat: { showOk: false } },
    },
    session: { store: storePath },
  };
  const send = vi.fn().mockResolvedValue({ messageId: "m1" });
  const seed = (entry: Partial<Parameters<typeof seedMainSessionStore>[2]> = {}) =>
    seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: TELEGRAM_GROUP,
      ...entry,
    });
  return {
    cfg,
    storePath,
    reply: replySpy,
    send,
    seed,
    silentOutcome: async (notify: boolean, summary: string) => {
      cfg.agents!.defaults!.heartbeat!.target = "none";
      const key = await seed();
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: notify ? "needs_attention" : "progress",
          notify,
          summary,
        }),
      );
      return key;
    },
    run: (options: RunOptions = {}, deps: Partial<HeartbeatDeps> = {}) =>
      runHeartbeatOnce({
        cfg,
        ...options,
        deps: {
          telegram: send,
          getQueueSize: () => 0,
          nowMs: () => 0,
          getReplyFromConfig: replySpy,
          ...deps,
        },
      }),
    claim: (sessionKey: string, runId = "next-user") =>
      heartbeatOutcomeStore.claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey,
        storePath,
        runId,
      }),
    read: (sessionKey: string) =>
      expectDefined(
        readSessionStoreForTest<SessionEntry>(storePath)[sessionKey],
        "heartbeat session",
      ),
  };
}
const test = it.extend<{ heartbeat: ReturnType<typeof createCase> }>({
  heartbeat: async ({ task: _task }, use) => {
    try {
      await withTempTelegramHeartbeatSandbox((sandbox) => use(createCase(sandbox)));
    } finally {
      speech.setTtsMachinePrefsPathResolver();
      speech.synthesizeMock.mockClear();
      hooks.resetGlobalHookRunner();
      await closeOpenClawAgentDatabasesAsync();
      vi.unstubAllEnvs();
      resetHeartbeatEventsForTest();
      resetSystemEventsForTest();
    }
  },
});
function usePlugin(plugin: ChannelPlugin) {
  const registry = createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]);
  setActivePluginRegistry(registry);
  return registry;
}
function buttons(label: string, value: string) {
  return { presentation: { blocks: [{ type: "buttons" as const, buttons: [{ label, value }] }] } };
}

test.for(["disconnected", "throws", "no-target"])(
  "checks readiness before the model and recovers: %s",
  async (failure, { heartbeat: { cfg, seed, reply, send, run } }) => {
    let ready = false;
    const checkReady = vi.fn(async () => {
      if (!ready && failure === "throws") {
        throw new Error("readiness unavailable");
      }
      return { ok: ready, reason: ready ? "ok" : "terminal-disconnect" };
    });
    usePlugin({ ...heartbeatRunnerTelegramPlugin, heartbeat: { checkReady } });
    if (failure === "no-target") {
      cfg.agents!.defaults!.heartbeat!.target = "none";
    }
    await seed();
    reply.mockResolvedValue({ text: "Deployment needs attention." });
    const result = await run();
    if (failure === "no-target") {
      expect(result.status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(checkReady).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ status: "skipped", reason: "channel-not-ready" });
      expect(reply).not.toHaveBeenCalled();
      expect(checkReady).toHaveBeenCalledOnce();
    }
    expect(send).not.toHaveBeenCalled();
    if (failure !== "no-target") {
      ready = true;
      expect((await run()).status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
    }
  },
);

test.for([
  { kind: "task", source: "interval", intent: "task" },
  { kind: "event", source: "cron", intent: "immediate" },
  { kind: "event", source: "interval", intent: "scheduled" },
  { kind: "manual", source: "manual", intent: "manual" },
] as const)(
  "executes $kind work from $source before gating unavailable delivery",
  async ({ kind, source, intent }, { heartbeat: { cfg, seed, reply, send, run } }) => {
    const payload = "Check inbox for queued work.";
    const order: string[] = [];
    usePlugin({
      ...heartbeatRunnerTelegramPlugin,
      heartbeat: {
        checkReady: async () => {
          order.push("readiness");
          return { ok: false, reason: "terminal-disconnect" };
        },
      },
    });
    cfg.agents!.defaults!.heartbeat!.prompt = kind === "manual" ? payload : "Ambient monitor only.";
    const sessionKey = await seed();
    if (kind === "event") {
      enqueueSystemEvent(`Reminder: ${payload}`, { sessionKey, contextKey: "cron:inbox" });
    }
    reply.mockImplementation(async () => {
      order.push("model");
      return { text: "Inbox needs attention." };
    });
    const result = await run({
      source,
      intent,
      ...(kind === "task"
        ? { tasks: [{ jobId: "inbox", name: "Check inbox", prompt: payload }] }
        : {}),
    });
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0].Body).toContain(payload);
    expect(order).toEqual(["model", "readiness"]);
    expect(result).toMatchObject({ status: "skipped", reason: "channel-not-ready" });
    expect(send).not.toHaveBeenCalled();
  },
);

test("delivers synthesized speech without placeholder text", async ({
  heartbeat: { cfg, seed, reply, send, run },
}) => {
  cfg.tts = { ...speech.createTtsConfig("heartbeat-speech-only").tts, auto: "tagged" };
  await seed();
  reply.mockResolvedValue([
    setReplyPayloadMetadata({ text: "" }, { tts: { tagged: true, text: "The build is ready." } }),
  ]);
  expect(await run()).toMatchObject({ status: "ran" });
  expect(speech.synthesizeMock).toHaveBeenCalledOnce();
  expect(speech.synthesizeMock.mock.calls[0]?.[0].text).toBe("The build is ready.");
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[1]).toBe("");
  expect(send.mock.calls[0]?.[2]).toMatchObject({
    mediaUrl: "https://example.test/heartbeat.ogg",
    audioAsVoice: true,
  });
});

test("persists the first silent outcome after boot", async ({
  heartbeat: { silentOutcome, send, run, claim },
}) => {
  const sessionKey = await silentOutcome(false, "First heartbeat after boot");
  await closeOpenClawAgentDatabasesAsync();
  expect(await run()).toMatchObject({ status: "ran" });
  expect(send).not.toHaveBeenCalled();
  await closeOpenClawAgentDatabasesAsync();
  expect(await claim(sessionKey)).toMatchObject({
    summary: "First heartbeat after boot",
    outcome: "progress",
  });
});

test.for([false, true])(
  "awaits outcome persistence failures (notify=%s)",
  async (notify, { heartbeat: { silentOutcome, send, run, claim } }) => {
    const sessionKey = await silentOutcome(notify, "Pending outcome");
    const entered = promises.createDeferred();
    const release = promises.createDeferred();
    const persist = vi
      .spyOn(heartbeatOutcomeStore, "persistHeartbeatOutcome")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
    const pending = run();
    try {
      await promises.awaitGateBeforeSettlement(entered.promise, pending, "persistence bypassed");
      release.reject(new Error("outcome storage unavailable"));
      expect(await pending).toMatchObject({ status: "failed" });
      expect(send).not.toHaveBeenCalled();
      expect(await claim(sessionKey)).toBeUndefined();
    } finally {
      release.resolve();
      await pending;
      persist.mockRestore();
    }
  },
);

test.for(["none", "same-id"] as const)(
  "records the first delivery only for its initialized session: %s",
  async (replacement, { heartbeat: { cfg, storePath, send, run, read } }) => {
    cfg.agents!.defaults!.heartbeat!.to = TELEGRAM_GROUP;
    const sessionKey = "agent:main:main";
    expect(readSessionStoreForTest(storePath)[sessionKey]).toBeUndefined();
    const replyResolver: InternalGetReplyFromConfig = async (ctx, options) => {
      const initialized = await initSessionState({
        ctx: finalizeInboundContext(ctx),
        cfg,
        commandAuthorized: true,
      });
      options?.onSessionPrepared?.({
        sessionKey: initialized.sessionKey,
        sessionId: initialized.sessionId,
        lifecycleRevision: initialized.sessionEntry.lifecycleRevision,
        storePath: initialized.storePath,
      });
      return { text: "Deployment requires attention." };
    };
    send.mockImplementation(async () => {
      if (replacement !== "none") {
        sessions.replaceSessionEntrySync(
          { storePath, sessionKey },
          {
            sessionId: read(sessionKey).sessionId,
            lifecycleRevision: "replacement-revision",
            updatedAt: Date.now(),
          },
        );
      }
      return { messageId: "first-alert" };
    });
    expect((await run({}, { getReplyFromConfig: replyResolver })).status).toBe("ran");
    expect(send).toHaveBeenCalledOnce();
    const stored = read(sessionKey);
    if (replacement === "none") {
      expect(stored).toMatchObject({
        lastHeartbeatText: "Deployment requires attention.",
        lastHeartbeatSentAt: 0,
      });
      await run({}, { getReplyFromConfig: replyResolver });
      expect(send).toHaveBeenCalledOnce();
    } else {
      expect(stored.lifecycleRevision).toBe("replacement-revision");
      expect(stored.lastHeartbeatText).toBeUndefined();
      expect(stored.lastHeartbeatSentAt).toBeUndefined();
    }
  },
);

test.for([
  { failure: "target-none", reason: "target-none" },
  { failure: "alerts-disabled", reason: "alerts-disabled" },
  { failure: "readiness-throws", reason: "readiness unavailable" },
  { failure: "hook-cancelled", reason: "message_sending_hook" },
  { failure: "send-failed", reason: "transport unavailable" },
])(
  "records a generated alert when $failure prevents confirmed delivery",
  async ({ failure, reason }, { heartbeat: { cfg, seed, reply, send, run, claim } }) => {
    cfg.agents!.defaults!.heartbeat!.target = failure === "target-none" ? "none" : "telegram";
    if (failure === "alerts-disabled") {
      cfg.channels = {
        ...cfg.channels,
        defaults: { heartbeatVisibility: { showAlerts: false } },
      };
    }
    const registry = usePlugin({
      ...heartbeatRunnerTelegramPlugin,
      heartbeat: {
        checkReady: async () => {
          if (failure === "readiness-throws" && reply.mock.calls.length > 0) {
            throw new Error(reason);
          }
          return { ok: failure !== "readiness", reason };
        },
      },
    });
    if (failure === "hook-cancelled") {
      addTestHook({
        registry,
        pluginId: "heartbeat-test-suppression",
        hookName: "message_sending",
        handler: () => ({ cancel: true }),
      });
      hooks.initializeGlobalHookRunner(registry);
    }
    const sessionKey = await seed();
    reply.mockResolvedValue(
      createHeartbeatToolResponsePayload({
        outcome: "needs_attention",
        notify: true,
        summary: "Build is blocked.",
        notificationText: "Build needs credentials.",
        reason: "Deployment check",
        priority: "high",
      }),
    );
    if (failure === "send-failed") {
      send.mockRejectedValue(new Error(reason));
    }
    const result = await run({ source: "manual", reason: "operator check" });
    expect(reply).toHaveBeenCalledOnce();
    expect(getLastHeartbeatEvent()?.indicatorType).toBe(
      failure === "send-failed" ? "error" : failure === "alerts-disabled" ? "alert" : undefined,
    );
    if (failure.startsWith("readiness")) {
      expect.soft(result).toMatchObject({
        status: "skipped",
        reason: "channel-not-ready",
        retryAtMs: expect.any(Number),
      });
      expect.soft(isRetryableHeartbeatSkipReason("channel-not-ready")).toBe(true);
    }
    await closeOpenClawAgentDatabasesAsync();
    const stored = await claim(sessionKey, "user-run");
    expect(stored).toMatchObject({
      outcome: "blocked",
      priority: "high",
      wakeSource: "manual",
      wakeReason: "operator check",
      summary: expect.stringContaining("Build needs credentials."),
    });
    expect(stored?.responseReason).toContain(reason);
    expect(stored?.responseReason).toContain("notify:true");
  },
);

test("delivers only the final non-reasoning answer", async ({
  heartbeat: { seed, reply, send, run },
}) => {
  await seed();
  reply.mockImplementation(async (_ctx, options) => {
    await options?.onBlockReply?.({ text: "Intermediate finding" });
    return [
      { text: "Superseded draft" },
      { text: "Final monitoring result" },
      { text: "Private reasoning", isReasoning: true },
    ];
  });
  expect((await run()).status).toBe("ran");
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[1]).toBe("Final monitoring result");
});

test("delivers changed actions with unchanged text", async ({
  heartbeat: { seed, reply, send, run },
}) => {
  await seed();
  const text = "Deployment approval required.";
  reply
    .mockResolvedValueOnce({ text, ...buttons("Review deployment", "review") })
    .mockResolvedValueOnce({ text, ...buttons("Approve deployment", "approve") });
  await run();
  await run();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]?.[1]).toContain("Review deployment");
  expect(send.mock.calls[1]?.[1]).toContain("Approve deployment");
});

test.for(["confirmed", "unknown"] as const)(
  "settles confirmed presentation delivery and retains unknown custody: %s",
  async (mode, { heartbeat: { storePath, seed, reply, send, run, read } }) => {
    const previous = {
      lastHeartbeatText: "Previous successful heartbeat",
      lastHeartbeatSentAt: 0,
    };
    const sessionKey = await seed(previous);
    reply.mockImplementation(async () => {
      const payload = buttons("Approve deployment", "approve");
      await sessions.patchSessionEntryCore(
        { storePath, sessionKey },
        (current) => {
          setReplyPayloadMetadata(payload, {
            pendingFinalDeliveryCompletion: {
              sessionKey,
              storePath,
              sessionId: current.sessionId,
              intentId: "structured-heartbeat-intent",
              deliveryId: "presentation",
            },
          });
          return {
            pendingFinalDelivery: {
              kind: "transport-only",
              createdAt: 0,
              intentId: "structured-heartbeat-intent",
              deliveries: [{ id: "presentation", state: "prepared" }],
            },
          };
        },
        { preserveActivity: true },
      );
      return payload;
    });
    send.mockResolvedValue({
      messageId: mode === "confirmed" ? "presentation-1" : undefined,
    });
    expect((await run()).status).toBe("ran");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(TELEGRAM_GROUP);
    expect(send.mock.calls[0]?.[1]).toContain("Approve deployment");
    const stored = read(sessionKey);
    expect(stored).toMatchObject(previous);
    if (mode === "confirmed") {
      expect(stored.pendingFinalDelivery).toBeUndefined();
    } else {
      expect(stored.pendingFinalDelivery).toMatchObject({
        intentId: "structured-heartbeat-intent",
        deliveries: [{ id: "presentation", state: "unknown" }],
      });
    }
  },
);

test("preserves reply metadata, channel data and voice", async ({
  heartbeat: { seed, reply, run },
}) => {
  await seed();
  const sendPayload = vi.fn().mockResolvedValue({ channel: "telegram", messageId: "metadata-1" });
  usePlugin(
    createOutboundTestPlugin({
      id: "telegram",
      outbound: {
        deliveryMode: "direct",
        sendText: vi.fn().mockResolvedValue({ messageId: "text-1" }),
        sendPayload,
      },
    }),
  );
  const payload = {
    text: "Deployment update",
    mediaUrl: "https://example.test/heartbeat.ogg",
    replyToId: "42",
    audioAsVoice: true,
    channelData: {
      telegram: { buttons: [[{ text: "Open deployment", callback_data: "open" }]] },
    },
  };
  reply.mockResolvedValue(setReplyPayloadMetadata(payload, { replyToIdExplicit: true }));
  expect((await run()).status).toBe("ran");
  expect(sendPayload).toHaveBeenCalledOnce();
  expect(sendPayload.mock.calls[0]?.[0]?.payload).toMatchObject(payload);
});
