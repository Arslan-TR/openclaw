// Trajectory runtime tests cover event recording and runtime file handling.
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { TRAJECTORY_RUNTIME_EVENT_MAX_BYTES } from "./paths.js";
import * as runtimeStoreWriter from "./runtime-store-writer.js";
import {
  loadSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEventRowsSync,
} from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder, toTrajectoryToolDefinitions } from "./runtime.js";

type TrajectoryRuntimeRecorder = NonNullable<
  Awaited<ReturnType<typeof createTrajectoryRuntimeRecorder>>
>;

const tempDirs = createTempDirTracker();

const fault = useSqliteWorkerFault([
  {
    name: "reject_trajectory_append",
    match: /^insert into trajectory_runtime_events\b/u,
    sql: `CREATE TEMP TRIGGER reject_trajectory_append BEFORE INSERT ON main.trajectory_runtime_events
      BEGIN SELECT RAISE(ABORT, 'synthetic SQLite persistence failure'); END;`,
  },
]);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function expectTrajectoryRuntimeRecorder(
  recorder: Awaited<ReturnType<typeof createTrajectoryRuntimeRecorder>>,
): TrajectoryRuntimeRecorder {
  if (recorder === null) {
    throw new Error("Expected trajectory runtime recorder");
  }
  expect(typeof recorder.recordEvent).toBe("function");
  return recorder;
}

function createCapturedRuntimeRecorder(
  writes: string[],
  params?: Partial<Parameters<typeof createTrajectoryRuntimeRecorder>[0]>,
) {
  vi.spyOn(runtimeStoreWriter, "createSqliteTrajectoryRuntimeSink").mockResolvedValueOnce({
    write: (_event, line) => writes.push(line),
    flush: async () => {},
    describeFlushState: () => undefined,
  });
  return createTrajectoryRuntimeRecorder({
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    ...params,
  });
}

describe("trajectory runtime", () => {
  it("records runtime payloads without credential masking by default", async () => {
    const writes: string[] = [];
    const recorder = await createCapturedRuntimeRecorder(writes, {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    const data = {
      systemPrompt: "system prompt",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
      oauth: "ya29.fake-access-token-with-enough-length",
      apple: "abcd-efgh-ijkl-mnop",
      tools: toTrajectoryToolDefinitions([
        { name: "z-tool", parameters: { z: 1 } },
        { name: "a-tool", description: "alpha", parameters: { a: 1 } },
        { name: " ", description: "ignored" },
      ]),
    };
    runtimeRecorder.recordEvent("context.compiled", data);

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.type).toBe("context.compiled");
    expect(parsed.source).toBe("runtime");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.data).toEqual(data);
    expect(parsed.data.tools).toEqual([
      { name: "a-tool", description: "alpha", parameters: { a: 1 } },
      { name: "z-tool", parameters: { z: 1 } },
    ]);
    expect(JSON.stringify(parsed.data)).toContain("sk-test-secret-token");
    expect(JSON.stringify(parsed.data)).toContain("sk-other-secret-token");
    expect(JSON.stringify(parsed.data)).toContain("ya29.fake-access-token");
    expect(JSON.stringify(parsed.data)).toContain("abcd-efgh-ijkl-mnop");
  });

  it("retains a failed SQLite flush batch for the next successful persistence attempt", async () => {
    const storePath = path.join(tempDirs.make("openclaw-trajectory-retry-"), "shared.sqlite");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:retry",
      sessionId: "retry-session",
      storePath,
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const recorder = expectTrajectoryRuntimeRecorder(
      await createTrajectoryRuntimeRecorder({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
      }),
    );
    recorder.recordEvent("already-persisted");
    await recorder.flush();
    recorder.recordEvent("before-failure");
    fault.enable();
    try {
      await expect(recorder.flush()).rejects.toThrow("synthetic SQLite persistence failure");
      expect(recorder.describeFlushState()).toContain("pendingRows=1");
    } finally {
      fault.disable();
    }
    recorder.recordEvent("after-failure");
    await recorder.flush();
    expect((await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type)).toEqual([
      "already-persisted",
      "before-failure",
      "after-failure",
    ]);
    expect(recorder.describeFlushState()).toBeUndefined();
  });

  it.each(["caller-env", "cwd"] as const)(
    "keeps queued logical-agent trajectory writes on their captured shared store (%s)",
    async (change) => {
      const callerRoot = tempDirs.make("openclaw-trajectory-caller-root-");
      const originalState = path.join(callerRoot, "state");
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(callerRoot);
      try {
        const env = {
          ...process.env,
          OPENCLAW_STATE_DIR: change === "cwd" ? "state" : originalState,
        };
        const capturedEnv = { ...env, OPENCLAW_STATE_DIR: originalState };
        const otherState = tempDirs.make("openclaw-trajectory-other-state-");
        const storePath = path.join(tempDirs.make("openclaw-shared-trajectory-"), "shared.sqlite");
        await replaceSessionEntry(
          { agentId: "main", env: capturedEnv, sessionKey: "agent:main:unrelated", storePath },
          { sessionId: "unrelated", updatedAt: 1 },
        );
        const target = {
          agentId: "ops",
          sessionKey: "agent:ops:trace",
          sessionId: "ops-session",
          storePath,
          env: capturedEnv,
        };
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
        const recorder = expectTrajectoryRuntimeRecorder(
          await createTrajectoryRuntimeRecorder({
            env,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            sessionTarget: target,
          }),
        );
        recorder.recordEvent("session.started");
        recorder.recordEvent("session.ended", { status: "success" });
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const reservation = runOpenClawAgentWorkerWrite(
          { agentId: "main", env: capturedEnv, path: storePath },
          async () => {
            entered.resolve();
            await release.promise;
          },
        );
        let flush: Promise<void> | undefined;
        try {
          await entered.promise;
          flush = recorder.flush();
          void flush.catch(() => {});
          if (change === "cwd") {
            cwd.mockReturnValue(otherState);
          } else {
            env.OPENCLAW_STATE_DIR = otherState;
          }
          await setImmediate();
          expect(recorder.describeFlushState()).toContain("pendingRows=2");
          release.resolve();
          await reservation;
          await flush;
        } finally {
          release.resolve();
          await reservation;
          await flush?.catch(() => {});
        }
        expect(fs.readdirSync(otherState)).toEqual([]);
        expect(
          (await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type),
        ).toEqual(["session.started", "session.ended"]);
        expect(loadSqliteTrajectoryRuntimeEventRowsSync({ ...target, tailEvents: 1 })).toEqual([
          expect.objectContaining({
            seq: 1,
            event: expect.objectContaining({
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
              type: "session.ended",
            }),
          }),
        ]);
        expect(inspectOpenClawAgentDatabaseOwner(storePath)).toMatchObject({
          status: "owned",
          agentId: "main",
        });
        expect(
          await loadSqliteTrajectoryRuntimeEvents({
            agentId: "main",
            env: capturedEnv,
            sessionId: "unrelated",
            storePath,
          }),
        ).toEqual([]);
      } finally {
        cwd.mockRestore();
      }
    },
  );

  it("rejects a legacy SQLite marker for another session", async () => {
    const storePath = path.join(tempDirs.make("openclaw-trajectory-runtime-"), "sessions.json");

    expect(
      await createTrajectoryRuntimeRecorder({
        sessionId: "current-session",
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "stale-session",
          storePath,
        }),
      }),
    ).toBeNull();
  });

  it.each([
    ["requested key", "agent:main:other", "main", "agent:main:main"],
    ["target key agent", undefined, "main", "agent:worker:main"],
  ])(
    "rejects a complete target that conflicts with the %s",
    async (_label, sessionKey, agentId, targetKey) => {
      const storePath = path.join(tempDirs.make("openclaw-trajectory-runtime-"), "sessions.json");

      expect(
        await createTrajectoryRuntimeRecorder({
          sessionId: "session-1",
          ...(sessionKey ? { sessionKey } : {}),
          sessionTarget: {
            agentId,
            sessionId: "session-1",
            sessionKey: targetKey,
            storePath,
          },
        }),
      ).toBeNull();
    },
  );

  it("rejects a complete target whose key maps to another session", async () => {
    const storePath = path.join(tempDirs.make("openclaw-trajectory-runtime-"), "sessions.json");
    const sessionKey = "agent:main:stored-session";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "stored-session",
        updatedAt: 1,
      },
    );

    expect(
      await createTrajectoryRuntimeRecorder({
        sessionId: "requested-session",
        sessionKey,
        sessionTarget: {
          agentId: "main",
          sessionId: "requested-session",
          sessionKey,
          storePath,
        },
      }),
    ).toBeNull();
  });

  it("stores bounded oversized runtime events in SQLite", async () => {
    const tempDir = tempDirs.make("openclaw-trajectory-runtime-");
    const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
      note: "Authorization: Bearer sk-inline-secret-token",
      apiKey: "sk-test-secret-token",
      authorization: "Bearer sk-other-secret-token",
    };
    const promptCache = { readTokens: 333_824, writeTokens: 51_130 };
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId: "session-1", updatedAt: 10 });
    const recorder = await createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-1",
        storePath,
      }),
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage,
      promptCache,
      assistantTexts: ["done"],
      finalPromptText: "inspect",
      messagesSnapshot: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });
    await runtimeRecorder.flush();

    const [event] = await loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath });
    expect(event).toMatchObject({
      type: "model.completed",
      data: {
        truncated: true,
        reason: "trajectory-event-size-limit",
        usage,
        promptCache,
        assistantTexts: ["done"],
        finalPromptText: "inspect",
      },
    });
    expect(event?.data?.messagesSnapshot).toBeUndefined();
    expect(event?.data?.droppedFields).toEqual(["messagesSnapshot"]);
    expect(event?.data?.finalPromptTextOriginalLength).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
    );
  });

  it("bounds oversized prompts before compact preservation", async () => {
    const writes: string[] = [];
    const recorder = await createCapturedRuntimeRecorder(writes);

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      prompt: "x".repeat(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data.truncated).toBeUndefined();
    expect(parsed.data.prompt.truncated).toBe(true);
    expect(parsed.data.prompt.reason).toBe("trajectory-field-size-limit");
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("preserves stopReason while dropping oversized preserved fields to keep runtime events bounded", async () => {
    const writes: string[] = [];
    const oversizedUsage = Object.fromEntries(
      Array.from({ length: 64 }, (_value, index) => [`field-${index}`, "x".repeat(5_000)]),
    );
    const promptCache = { readTokens: 333_824, writeTokens: 51_130 };
    const recorder = await createCapturedRuntimeRecorder(writes);

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      threadId: "thread-compact",
      turnId: "turn-compact",
      timedOut: true,
      yieldDetected: false,
      aborted: true,
      promptError: "terminal prompt error",
      usage: oversizedUsage,
      promptCache,
      stopReason: "length",
      assistantTexts: Array.from(
        { length: 12 },
        (_value, index) => `assistant-${index} ${"x".repeat(32_000)}`,
      ),
      messagesSnapshot: [{ role: "user", content: "x".repeat(32_000) }],
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      threadId: "thread-compact",
      turnId: "turn-compact",
      timedOut: true,
      yieldDetected: false,
      aborted: true,
      promptError: "terminal prompt error",
      promptCache,
      stopReason: "length",
    });
    expect(parsed.data.usage).toBeUndefined();
    expect(parsed.data.assistantTexts).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(
      expect.arrayContaining(["usage", "assistantTexts", "messagesSnapshot"]),
    );
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("preserves the prompt when an oversized event drops inlined conversation state", async () => {
    const writes: string[] = [];
    const prompt = "summarize the incident timeline for the deploy that failed";
    const recorder = await createCapturedRuntimeRecorder(writes);

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      prompt,
      systemPrompt: "x".repeat(32_000),
      messages: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      prompt,
      systemPrompt: "x".repeat(32_000),
    });
    expect(parsed.data.messages).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(["messages"]);
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("drops repeated conversation fields in priority order", async () => {
    const writes: string[] = [];
    const prompt = "summarize the incident timeline";
    const messageBlocks = Array.from({ length: 12 }, (_value, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index} ${"x".repeat(32_000)}`,
    }));
    const recorder = await createCapturedRuntimeRecorder(writes);

    expectTrajectoryRuntimeRecorder(recorder).recordEvent("context.compiled", {
      prompt,
      messagesSnapshot: messageBlocks,
      messages: messageBlocks,
      systemPrompt: "x".repeat(32_760),
      tools: Array.from({ length: 7 }, (_value, index) => ({
        name: `tool-${index}`,
        description: "x".repeat(32_760),
      })),
    });

    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data.prompt).toBe(prompt);
    expect(parsed.data.tools).toHaveLength(7);
    expect(parsed.data.messagesSnapshot).toBeUndefined();
    expect(parsed.data.messages).toBeUndefined();
    expect(parsed.data.systemPrompt).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(["messagesSnapshot", "messages", "systemPrompt"]);
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("preserves the prompt in the compact fallback for oversized events", async () => {
    const writes: string[] = [];
    const prompt = "summarize the incident timeline for the deploy that failed";
    const recorder = await createCapturedRuntimeRecorder(writes);

    expectTrajectoryRuntimeRecorder(recorder).recordEvent("context.compiled", {
      prompt,
      tools: Array.from({ length: 12 }, (_value, index) => ({
        name: `tool-${index}`,
        description: "x".repeat(32_000),
      })),
    });

    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      prompt,
    });
    expect(parsed.data.tools).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(["tools"]);
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("caps large final prompts and records their original length", async () => {
    const writes: string[] = [];
    const finalPromptText = `prompt-${"🙂".repeat(4_096)}`;
    const recorder = await createCapturedRuntimeRecorder(writes);

    expectTrajectoryRuntimeRecorder(recorder).recordEvent("model.completed", { finalPromptText });

    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(Buffer.byteLength(parsed.data.finalPromptText, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(parsed.data.finalPromptText, "utf8")).toBeGreaterThan(4 * 1024 - 4);
    expect(parsed.data.finalPromptTextOriginalLength).toBe(finalPromptText.length);
  });

  it("does not record runtime events when explicitly disabled", async () => {
    const recorder = await createTrajectoryRuntimeRecorder({
      env: {
        OPENCLAW_TRAJECTORY: "0",
      },
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
    });

    expect(recorder).toBeNull();
  });
});
