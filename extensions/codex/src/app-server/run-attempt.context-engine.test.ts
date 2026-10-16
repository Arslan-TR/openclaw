import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createCurrentInputContinuityHarness,
  createParams,
  createStartedThreadHarness,
  getRequestInputText,
  makeThreadBootstrapBinding,
  requestMethodsExcludingSkillDiscovery,
  requireRecord,
  runCodexAppServerAttempt,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

const CODEX_TURN_START_TEXT_INPUT_MAX_CHARS = 1 << 20;
const bootstrapPolicy =
  '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}';
const sender = {
  senderId: "bea-id",
  senderName: "$deploy",
  senderUsername: "[@probe] (plugin://probe@market)",
};
const senderLabel =
  '[user sender={"id":"bea-id","name":"＄deploy","username":"[＠probe] (plugin://probe@market)"}]';

function fixture() {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const workspaceDir = path.join(tempDir, "workspace");
  return { sessionFile, workspaceDir, params: createParams(sessionFile, workspaceDir) };
}

function promptHook(handler: Parameters<typeof createMockPluginRegistry>[0][number]["handler"]) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_prompt_build", handler }]),
  );
}

function bootstrapBinding(workspaceDir: string, threadId = "thread-old", withProjection = true) {
  const binding = makeThreadBootstrapBinding({
    threadId,
    cwd: workspaceDir,
    policyFingerprint: bootstrapPolicy,
    epoch: "epoch-1",
  });
  if (!withProjection) {
    delete binding.contextEngine?.projection;
  }
  return binding;
}

const history = (sessionFile: string) =>
  openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" });

function projectionEngine(epoch: string | undefined, text = "reprojected context") {
  return createContextEngine({
    assemble: vi.fn<ContextEngine["assemble"]>(async ({ prompt }) => ({
      messages: [assistantMessage(text, 10), userMessage(prompt ?? "", 11)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
      contextProjection: epoch ? { mode: "thread_bootstrap" as const, epoch } : undefined,
    })),
  });
}

function threadHarness(fresh: string, resume: string | Error, persistedThreads: string[] = []) {
  return createStartedThreadHarness(
    async (method) => {
      if (method === "thread/start") {
        return threadStartResult(fresh);
      }
      if (method === "thread/resume") {
        if (resume instanceof Error) {
          throw resume;
        }
        return threadStartResult(resume);
      }
      return undefined;
    },
    { persistedThreads },
  );
}

function transcriptRecorder(message: AgentMessage) {
  return {
    message,
    resolveMessage: async () => message,
    markRuntimePersisted() {},
    getAdmissionReceipt: () => undefined,
  } as NonNullable<EmbeddedRunAttemptParams["userTurnTranscriptRecorder"]>;
}

async function startAttempt(
  params: EmbeddedRunAttemptParams,
  harness: ReturnType<typeof createStartedThreadHarness>,
) {
  const run = runCodexAppServerAttempt(params);
  await awaitGateBeforeSettlement(
    harness.waitForMethod("turn/start"),
    run,
    "Codex attempt completed before turn/start",
  );
  return async (threadId = "thread-1") => {
    await harness.completeTurn("completed", threadId);
    return await run;
  };
}

async function createSqliteParams(workspaceDir: string, storeName: string) {
  const target = {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    storePath: path.join(tempDir, `${storeName}.sqlite`),
  };
  const sessionFile = formatSqliteSessionFileMarker(target);
  const params = createParams(sessionFile, workspaceDir);
  await upsertSessionEntry({
    ...target,
    entry: { sessionFile, sessionId: target.sessionId, updatedAt: Date.now() },
  });
  return {
    ...params,
    sessionTarget: target,
    userTurnTranscriptRecorder: transcriptRecorder(userMessage("hello", Date.now())),
  };
}

function requireRequestParams(
  harness: ReturnType<typeof createStartedThreadHarness>,
  method: string,
): Record<string, unknown> {
  const request = harness.requests.find((entry) => entry.method === method);
  return requireRecord(request?.params, `${method} params`);
}

function expectInput(
  harness: ReturnType<typeof createStartedThreadHarness>,
  contains: string[],
  excludes: string[] = [],
): void {
  const input = getRequestInputText(harness);
  for (const text of contains) {
    expect(input).toContain(text);
  }
  for (const text of excludes) {
    expect(input).not.toContain(text);
  }
}

function expectMethods(
  harness: ReturnType<typeof createStartedThreadHarness>,
  methods: string[],
  requirements = true,
) {
  expect(requestMethodsExcludingSkillDiscovery(harness)).toEqual([
    "config/read",
    ...(requirements ? ["configRequirements/read"] : []),
    ...methods,
    "turn/start",
  ]);
}

function expectSender(
  harness: ReturnType<typeof createStartedThreadHarness>,
  prompt: string,
  prefix = "",
) {
  expectInput(
    harness,
    [`${prefix}Current user request:\n${senderLabel}\n${prompt}`],
    ["$deploy", "[@probe]"],
  );
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt context-engine lifecycle", () => {
  it("bootstraps and assembles a compaction summary before the Codex turn starts", async () => {
    const { sessionFile, params } = fixture();
    const sessionManager = history(sessionFile);
    const summary = "The durable code is summary-only-engine-code-8516.";
    const retainedId = sessionManager.appendMessage(
      assistantMessage("ACK: existing context", Date.now()),
    );
    sessionManager.appendCompaction(summary, retainedId, 1_000);
    const openSpy = vi.spyOn(SessionManager, "open");
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    params.prompt =
      "Recall the durable code using $current-skill and [@current](plugin://current@market).";
    const admittedMessage = {
      ...userMessage(params.prompt, Date.now()),
      idempotencyKey: "current-request:user",
      __openclaw: sender,
    } as AgentMessage;
    params.userTurnTranscriptRecorder = transcriptRecorder(admittedMessage);
    params.currentInboundContext = { text: "Current inbound reply context" };
    params.contextEngine = contextEngine;
    params.sandboxSessionKey = "agent:main:telegram:default:direct:12345";
    params.contextTokenBudget = 321;
    params.requestedModelId = "gpt-5.4-codex-primary";
    params.fallbackReason = "provider_unavailable";
    params.degradedReason = "context_overflow";
    params.config = { memory: { citations: "on" } } as EmbeddedRunAttemptParams["config"];
    setRuntimeConfigSnapshot(params.config ?? {});

    const finish = await startAttempt(params, harness);

    const runtimeSettings = {
      runtime: { mode: "degraded" },
      model: { requested: "gpt-5.4-codex-primary", resolved: "gpt-5.4-codex" },
      diagnostics: {
        fallbackReason: "provider_unavailable",
        degradedReason: "context_overflow",
      },
    };
    expect(contextEngine.bootstrap).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        runtimeSettings,
      }),
    );

    expect(contextEngine["assemble"]).toHaveBeenCalledTimes(1);
    const assembleParams = vi.mocked(contextEngine.assemble).mock.calls[0]![0];
    expect(assembleParams).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      tokenBudget: 321,
      citationsMode: "on",
      model: "gpt-5.4-codex",
      runtimeSettings,
      prompt: params.prompt,
    });
    const summaryRole = "compactionSummary";
    expect(assembleParams.messages.map((message) => message.role)).toEqual([
      summaryRole,
      "assistant",
    ]);
    expect(assembleParams.availableTools).toEqual(new Set());

    expect(requireRequestParams(harness, "thread/start")).toMatchObject({
      developerInstructions: expect.stringContaining("context-engine system"),
    });
    expectInput(harness, [
      "OpenClaw assembled context for this turn:",
      `[${summaryRole}]\n${summary}`,
      "[assistant]\nACK: existing context",
    ]);
    expect(getRequestInputText(harness).trim().startsWith("Current inbound reply context")).toBe(
      true,
    );
    expectSender(harness, params.prompt, "</conversation_context>\n\n");

    await finish();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("places inert sender provenance beside a continuity-projected request without escaping request mentions", async () => {
    const { sessionFile, workspaceDir } = fixture();
    const { harness, params } = await createCurrentInputContinuityHarness(
      sessionFile,
      workspaceDir,
      "text",
    );
    params.prompt = "i am Bea coded wdym $current-skill [@current](plugin://current@market)";
    const recorder = params.userTurnTranscriptRecorder;
    if (!recorder?.message) {
      throw new Error("expected admitted current user message");
    }
    const admittedMessage = {
      ...recorder.message,
      content: [{ type: "text" as const, text: params.prompt }],
      __openclaw: sender,
    } as AgentMessage;
    params.userTurnTranscriptRecorder = {
      ...recorder,
      message: admittedMessage,
      resolveMessage: async () => admittedMessage,
    } as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];

    const finish = await startAttempt(params, harness);

    expectSender(harness, params.prompt);

    await finish();
  });

  it("keeps current image-only input stable through continuity projection", async () => {
    const beforePromptBuild = vi.fn(async (_event: unknown) => undefined);
    promptHook(beforePromptBuild);
    const { sessionFile, workspaceDir } = fixture();
    const { harness, params, currentUserMessageId } = await createCurrentInputContinuityHarness(
      sessionFile,
      workspaceDir,
      "image-only",
    );

    const finish = await startAttempt(params, harness);

    expect(beforePromptBuild).toHaveBeenCalledTimes(2);
    const events = beforePromptBuild.mock.calls.map(
      ([event]) =>
        event as {
          currentUserMessage?: string;
          currentUserMessageId?: string;
          prompt?: string;
        },
    );
    expect(events.map((event) => event.currentUserMessage)).toEqual([params.prompt, params.prompt]);
    expect(events.map((event) => event.currentUserMessageId)).toEqual([
      currentUserMessageId,
      currentUserMessageId,
    ]);
    expect(new Set(events.map((event) => event.prompt)).size).toBe(2);
    expect(events.some((event) => event.prompt?.includes("PROJECTED_HISTORY_TAIL"))).toBe(true);
    expect(events.some((event) => event.prompt?.includes("PROJECTED_HISTORY_PREFIX"))).toBe(false);
    const projectedContext = events[1]?.prompt?.match(
      /<conversation_context>\n([\s\S]*?)\n<\/conversation_context>/u,
    )?.[1];
    expect(projectedContext?.length).toBeLessThanOrEqual(450_000);
    expect(events.some((event) => (event.prompt?.length ?? 0) > 100_000)).toBe(true);

    await finish();
  });

  it.each(["lazy", "none"] as const)(
    "keeps the admitted input during runtime refresh with recorder: %s",
    async (recorderKind) => {
      const withRecorder = recorderKind !== "none";
      const beforePromptBuild = vi.fn(async (_event: unknown) => undefined);
      promptHook(beforePromptBuild);
      const { params } = fixture();
      const harness = createStartedThreadHarness();
      params.prompt = "Transport context and media wrapping, or continue after runtime refresh.";
      const admittedMessage = {
        ...userMessage("What do you remember about my preferences?", 10),
        idempotencyKey: "refresh-original:user",
      };
      if (withRecorder) {
        params.userTurnTranscriptRecorder = {
          ...transcriptRecorder(admittedMessage),
          message: undefined,
        };
      }
      params.pluginRuntimeRefreshMessages = [
        admittedMessage,
        assistantMessage("Work completed before refresh.", 20),
      ];

      const finish = await startAttempt(params, harness);

      expect(beforePromptBuild).toHaveBeenCalled();
      for (const [event] of beforePromptBuild.mock.calls) {
        expect(event).toMatchObject({
          currentUserMessage: withRecorder ? "What do you remember about my preferences?" : "",
        });
        if (withRecorder) {
          expect(event).toHaveProperty("currentUserMessageId", "refresh-original:user");
        } else {
          expect(event).not.toHaveProperty("currentUserMessageId");
        }
      }

      await finish();
    },
  );

  it.each(["active engine", "relocated delivery metadata", "empty prompt"] as const)(
    "bounds hook-appended output with %s",
    async (scenario) => {
      const { params } = fixture();
      const harness = createStartedThreadHarness();
      const active = scenario === "active engine";
      const empty = scenario === "empty prompt";
      if (active) {
        promptHook(async (event) => ({
          appendContext: `${(event as { prompt: string }).prompt}\n\nhook append marker`,
          prependContext: "hook prefix context",
        }));
        params.contextEngine = createContextEngine({
          assemble: vi.fn(async () => ({
            messages: [
              ...Array.from({ length: 9 }, (_, i) =>
                assistantMessage(`older context ${i} ${"x".repeat(120_000)}`, i),
              ),
              assistantMessage("recent anchor", 10),
            ],
            estimatedTokens: 300_000,
          })),
        });
        params.contextTokenBudget = 300_000;
        params.prompt = "current prompt survives";
        params.currentInboundContext = { text: "current inbound context survives" };
      } else {
        promptHook(async () => ({
          appendContext: `hook context ${"h".repeat(1_100_000)}${empty ? " hook tail" : ""}`,
        }));
        params.prompt = empty ? "" : `${MESSAGE_TOOL_DELIVERY_HINTS[0]}\n\ncurrent prompt survives`;
      }

      const finish = await startAttempt(params, harness);
      const inputText = getRequestInputText(harness);
      if (active) {
        expect(inputText.length).toBe(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
        expectInput(harness, [
          "recent anchor",
          "current inbound context survives",
          "current prompt survives",
          "hook append marker",
        ]);
      } else {
        expect(inputText.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
        expectInput(
          harness,
          [empty ? "hook tail" : "Current user request:\ncurrent prompt survives"],
          empty ? [] : ["hook context"],
        );
      }
      await finish();
    },
  );

  it.each(["byte guard", "token pressure", "inactive engine"] as const)(
    "preserves bootstrap ownership under %s",
    async (scenario) => {
      const { sessionFile, workspaceDir, params } = fixture();
      const agentDir = path.join(tempDir, "agent");
      const resumed = scenario === "byte guard";
      const active = scenario !== "inactive engine";
      await writeCodexAppServerBinding(sessionFile, {
        ...bootstrapBinding(workspaceDir, "thread-bootstrapped"),
        model: "gpt-5.4-codex",
        modelProvider: "openai",
      });
      await fs.writeFile(
        path.join(path.dirname(sessionFile), "sessions.json"),
        JSON.stringify({ "agent:main:session-1": { sessionFile, totalTokens: 12_000 } }),
      );
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      await fs.mkdir(rolloutDir, { recursive: true });
      const usage = JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: resumed ? 12_000 : active ? 241_198 : 300_000 },
            ...(resumed || active ? { model_context_window: 258_400 } : {}),
          },
        },
      });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-thread-bootstrapped.jsonl"),
        resumed
          ? [
              "x".repeat(2_000),
              JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4-codex" } }),
              usage,
              "",
            ].join("\n")
          : `${usage}\n`,
      );
      params.agentDir = agentDir;
      const engine = projectionEngine("epoch-1");
      const assemble = engine.assemble;
      if (active) {
        params.contextEngine = engine;
      } else {
        const manager = history(sessionFile);
        manager.appendMessage(userMessage("previous stale-bootstrap request", Date.now()));
        manager.appendMessage(assistantMessage("previous stale-bootstrap answer", Date.now() + 1));
      }
      if (scenario !== "token pressure") {
        params.config = {
          agents: {
            defaults: { compaction: { maxActiveTranscriptBytes: resumed ? 1_000 : "1mb" } },
          },
        };
        setRuntimeConfigSnapshot(params.config);
      }
      const harness = threadHarness(
        "thread-fresh",
        "thread-bootstrapped",
        resumed ? ["thread-bootstrapped"] : [],
      );
      const finish = await startAttempt(params, harness);
      expectMethods(
        harness,
        resumed ? ["thread/read", "thread/resume", "thread/inject_items"] : ["thread/start"],
      );
      const inputText = getRequestInputText(harness);
      if (resumed) {
        expect(inputText).toBe("hello");
        expect(assemble).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: 258_400 }));
      } else if (active) {
        expectInput(harness, ["OpenClaw assembled context for this turn:", "reprojected context"]);
      } else {
        expectInput(
          harness,
          ["hello"],
          [
            "OpenClaw assembled context for this turn:",
            "previous stale-bootstrap request",
            "previous stale-bootstrap answer",
            "Current user request:",
          ],
        );
      }
      await finish(resumed ? "thread-bootstrapped" : "thread-fresh");
    },
  );

  it("keeps mirrored history when an inactive per-turn context-engine binding starts fresh", async () => {
    const { sessionFile, workspaceDir, params } = fixture();
    const sessionManager = history(sessionFile);
    sessionManager.appendMessage(userMessage("previous per-turn request", 10) as never);
    sessionManager.appendMessage(assistantMessage("previous per-turn answer", 11) as never);
    await writeCodexAppServerBinding(
      sessionFile,
      bootstrapBinding(workspaceDir, "thread-per-turn-context", false),
    );
    const harness = threadHarness(
      "thread-fresh",
      new Error("inactive context-engine bindings should start a fresh thread"),
    );
    const finish = await startAttempt(params, harness);

    expectMethods(harness, ["thread/start"]);
    expectInput(harness, [
      "OpenClaw assembled context for this turn:",
      "previous per-turn request",
      "previous per-turn answer",
      "Current user request:",
      "hello",
    ]);

    await finish("thread-fresh");
  });

  it.each([
    { change: "policy", epoch: "epoch-1", tokenBudget: 80_000 },
    {
      change: "per-turn projection",
      epoch: undefined,
      tokenBudget: undefined,
    },
  ])(
    "starts fresh and reprojects after a context-engine $change change",
    async ({ epoch, tokenBudget }) => {
      const { sessionFile, workspaceDir, params } = fixture();
      await writeCodexAppServerBinding(sessionFile, bootstrapBinding(workspaceDir));
      const contextEngine = projectionEngine(epoch);
      const harness = threadHarness("thread-new", "thread-old");
      params.contextEngine = contextEngine;
      params.contextTokenBudget = tokenBudget;

      const finish = await startAttempt(params, harness);
      expectMethods(harness, ["thread/start"]);
      expectInput(harness, ["OpenClaw assembled context for this turn:", "reprojected context"]);
      await finish("thread-new");

      const savedBinding = await readCodexAppServerBinding(sessionFile);
      expect(savedBinding?.threadId).toBe("thread-new");
      if (epoch) {
        expect(savedBinding?.contextEngine?.projection?.epoch).toBe(epoch);
      } else {
        expect(savedBinding?.contextEngine?.projection).toBeUndefined();
      }
    },
  );

  it("reprojects thread-bootstrap context for native-disabled transient Codex threads", async () => {
    const restoreSandboxBackend = registerSandboxBackend(
      "codex-context-test-sandbox",
      async () => ({
        id: "codex-context-test-sandbox",
        runtimeId: "codex-context-test-runtime",
        runtimeLabel: "Codex Context Test Sandbox",
        workdir: "/workspace",
        buildExecSpec: async () => ({
          argv: ["true"],
          env: {},
          stdinMode: "pipe-closed" as const,
        }),
        runShellCommand: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
        }),
      }),
    );
    const { sessionFile, workspaceDir, params } = fixture();
    try {
      await writeCodexAppServerBinding(sessionFile, bootstrapBinding(workspaceDir));
      const harness = threadHarness(
        "thread-transient",
        new Error("native-disabled turns should not resume the previous Codex thread"),
      );
      params.contextEngine = projectionEngine("epoch-1", "native-disabled context");
      params.config = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "codex-context-test-sandbox",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"];
      setRuntimeConfigSnapshot(params.config ?? {});

      const finish = await startAttempt(params, harness);

      expectMethods(harness, ["thread/start"], false);
      expectInput(harness, [
        "OpenClaw assembled context for this turn:",
        "native-disabled context",
      ]);

      await finish("thread-transient");
    } finally {
      restoreSandboxBackend();
    }
  });

  it("returns an exact terminal anchor for Gateway-routed heartbeat turns without finalizing inside Codex", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const afterTurn = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
    );
    const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const contextEngine = createContextEngine({ afterTurn, maintain, bootstrap: undefined });
    const harness = createStartedThreadHarness();
    const params = await createSqliteParams(workspaceDir, "heartbeat-heartbeat");
    params.contextEngine = contextEngine;
    params.trigger = "user";
    params.bootstrapContextRunKind = "heartbeat";
    params.contextTokenBudget = 111;
    params.requestedModelId = "gpt-5.4-codex-primary";
    params.fallbackReason = "provider_unavailable";
    params.degradedReason = "context_overflow";

    const finish = await startAttempt(params, harness);
    const result = await finish();

    expect(result.contextEngineTerminalAnchor).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    expect(afterTurn).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
  });

  it("persists the admitted user prompt before an async item buffered during turn startup", async () => {
    const workspaceDir = path.join(tempDir, "workspace-early-async");
    const params = await createSqliteParams(workspaceDir, "early-async-order");
    const delivered = Promise.withResolvers<void>();
    params.onBlockReply = vi.fn(() => delivered.resolve());
    params.sandboxSessionKey = "agent:main:policy";
    params.contextEngine = createContextEngine();
    const beforeMessageWrite = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_message_write", handler: beforeMessageWrite }]),
    );
    const recorder = params.userTurnTranscriptRecorder;
    recorder.markRuntimePersistencePending = vi.fn();
    recorder.markRuntimePersisted = vi.fn();
    recorder.markSentToProvider = vi.fn(() => {
      throw new Error("admission is not available before Codex turn/start");
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        await harness.notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "startup-async",
              phase: "final_answer",
              delivery: "async",
              text: "Working on the request.",
            },
          },
        });
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await awaitGateBeforeSettlement(
      delivered.promise,
      run,
      "Codex attempt completed before delivering its buffered async item",
    );
    expect(params.onBlockReply).toHaveBeenCalledOnce();
    expect(recorder.markSentToProvider).not.toHaveBeenCalled();
    expect(recorder.markRuntimePersisted).toHaveBeenCalledOnce();
    expect(beforeMessageWrite).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
      { agentId: "main", sessionKey: params.sessionKey },
    );
    await harness.completeTurn();
    await run;

    const messages = (await readSessionTranscriptEvents(params.sessionTarget))
      .map((event) => (event as { message?: { role?: string } }).message)
      .filter((message) => message !== undefined);
    expect(messages.slice(0, 2).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]).toMatchObject({ openclawAsyncDelivery: { itemId: "startup-async" } });
  });

  it("logs assemble failures as a formatted message instead of the raw error object", async () => {
    const { sessionFile, params } = fixture();
    const manager = history(sessionFile);
    manager.appendMessage(assistantMessage("first baseline message", 1) as never);
    manager.appendMessage(userMessage("second baseline message", 2) as never);
    let preassemblyMessages: AgentMessage[] = [];
    let promptHookMessages: AgentMessage[] = [];
    promptHook(async (event) => {
      promptHookMessages = (event as { messages: AgentMessage[] }).messages;
      return {};
    });
    const rawError = new Error("Authorization: Bearer sk-abcdefghijklmnopqrstuv");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ messages }) => {
        preassemblyMessages = messages.slice();
        messages.reverse();
        messages.pop();
        throw rawError;
      }),
      bootstrap: undefined,
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createStartedThreadHarness();
    params.contextEngine = contextEngine;

    const finish = await startAttempt(params, harness);
    await finish();

    const warning = warn.mock.calls.find(
      ([message]) => message === "context engine assemble failed; using Codex baseline prompt",
    );
    const details = requireRecord(warning?.[1], "assemble warning details");
    expect(typeof details.error).toBe("string");
    expect(warning?.[1]).not.toEqual({ error: rawError });
    expect(String(details.error)).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(promptHookMessages).toEqual(preassemblyMessages);
    expect(promptHookMessages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expectInput(harness, [params.prompt]);
  });
});

describe("Codex configured context budget", () => {
  it.each(["text", "images", "no authored cap"] as const)(
    "reserves native overhead only with an authored exact-model cap (%s)",
    async (scenario) => {
      const authored = scenario !== "no authored cap";
      const contextEngine = createContextEngine();
      const { sessionFile, params } = fixture();
      const harness = createStartedThreadHarness();
      params.contextEngine = contextEngine;
      params.contextTokenBudget = 500_000;
      if (authored) {
        history(sessionFile).appendMessage(userMessage("PRIOR_BUDGET_CONTEXT", 10));
        params.authoredContextTokenCap = 600_000;
        params.prompt = `CURRENT_REQUEST ${"current ".repeat(1_000).trimEnd()}`;
        params.currentInboundContext = { text: "CURRENT_INBOUND_REFERENCE" };
      }
      if (scenario === "images") {
        params.images = [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
          },
        ];
      }

      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      await harness.completeTurn();
      await run;

      const assembly = vi.mocked(contextEngine.assemble).mock.calls[0]?.[0];
      if (authored) {
        expect(assembly?.tokenBudget).toBeGreaterThan(0);
        expect(assembly?.tokenBudget).toBeLessThan(480_000);
        expect(assembly?.runtimeSettings?.limits.maxOutputTokens).toBe(20_000);
        const bootstrapCall = vi.mocked(contextEngine.bootstrap!).mock.calls[0]?.[0];
        expect(bootstrapCall?.runtimeSettings?.limits.promptTokenBudget).toBe(500_000);
        expectInput(harness, [params.prompt, "CURRENT_INBOUND_REFERENCE"]);
      } else {
        expect(assembly?.tokenBudget).toBe(500_000);
      }
      expect(assembly?.runtimeSettings?.limits.promptTokenBudget).toBe(assembly?.tokenBudget);
      expect(harness.requests.some(({ method }) => method === "thread/inject_items")).toBe(false);
    },
  );
});
