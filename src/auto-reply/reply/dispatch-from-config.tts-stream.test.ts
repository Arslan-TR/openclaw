// Register dispatch mocks before modules that consume them.
// oxfmt-ignore
import { emptyConfig, ttsMocks } from "./dispatch-from-config.shared.test-harness.js";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import * as sqliteEntries from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionActor from "../../config/sessions/session-actor-scope.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import * as directives from "../../tts/directives.js";
import {
  getReplyPayloadMetadata as metadata,
  setReplyPayloadMetadata as withMetadata,
} from "../reply-payload.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  installCaptionedVoiceTestPlugin,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

type DispatchInput = Parameters<typeof dispatchReplyFromConfig>[0];

async function dispatchStream({
  channel = "qa-channel",
  ...params
}: Omit<DispatchInput, "ctx" | "cfg"> & { channel?: string }) {
  const result = await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: channel, Surface: channel }),
    cfg: emptyConfig,
    ...params,
  });
  params.dispatcher.markComplete();
  await params.dispatcher.waitForIdle();
  return result;
}

function collectingDispatcher() {
  const delivered: ReplyPayload[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      delivered.push(payload);
    },
  });
  return { delivered, dispatcher };
}

function streamPipeline(options?: GetReplyOptions) {
  return createBlockReplyPipeline({
    onBlockReply: (payload, context) => options?.onBlockReply?.(payload, context),
    timeoutMs: 0,
  });
}

function buildStreamReplies(payload: ReplyPayload, pipeline: ReturnType<typeof streamPipeline>) {
  return buildReplyPayloads({
    payloads: [payload],
    isHeartbeat: false,
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: true,
    blockReplyPipeline: pipeline,
    replyToMode: "off",
  });
}

async function withStream<T>(
  options: GetReplyOptions | undefined,
  run: (pipeline: ReturnType<typeof streamPipeline>) => Promise<T>,
) {
  const pipeline = streamPipeline(options);
  try {
    return await run(pipeline);
  } finally {
    pipeline.stop();
  }
}

async function restoreSessionPersistence() {
  const actual = await vi.importActual<typeof sessions>(
    "../../config/sessions/session-accessor.js",
  );
  const actor = await vi.importActual<typeof sessionActor>(
    "../../config/sessions/session-actor-scope.js",
  );
  const sqlite = await vi.importActual<typeof sqliteEntries>(
    "../../config/sessions/session-accessor.sqlite-entry.js",
  );
  vi.spyOn(sessionActor, "withSessionActor").mockImplementation(actor.withSessionActor);
  vi.spyOn(sessions, "patchSessionEntryCore").mockImplementation(actual.patchSessionEntryCore);
  vi.spyOn(sqliteEntries, "applySessionEntryOperation").mockImplementation(
    sqlite.applySessionEntryOperation,
  );
  return actual;
}

const deliveryIdentity = { intentId: "source-intent", deliveryId: "source-delivery" };
function completion(storePath: string, prepared = false) {
  return {
    ...deliveryIdentity,
    storePath,
    sessionId: prepared ? "source-session" : "session-1",
    sessionKey: prepared ? "agent:main:discord:direct:source-completion" : "agent:main:main",
  };
}

function installPartialCleaner(onLiteral?: () => void) {
  let buffered = false;
  vi.spyOn(directives, "createTtsDirectiveTextStreamCleaner").mockReturnValue({
    push: (text) => {
      buffered = text === "See [";
      if (!buffered) {
        onLiteral?.();
      }
      return buffered ? "See " : text;
    },
    hasBufferedDirectiveText: () => buffered,
    flush: () => "[",
  });
}

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});

it.each<[string[], string]>([
  [["Intro [", "[tts:text]]hidden[[/tts:text]] visible"], "Intro  visible"],
  [["Intro [[tts:text]]hidden[", "[/tts:text]] visible"], "Intro  visible"],
  [["[[tts:text]]hidden["], ""],
])("settles split directives %j once", async (chunks, visible) => {
  ttsMocks.state.synthesizeFinalAudio = true;
  const { delivered, dispatcher } = collectingDispatcher();
  await dispatchStream({
    dispatcher,
    replyResolver: (_ctx, opts) =>
      withStream(opts, async (pipeline) => {
        for (const text of chunks) {
          pipeline.enqueue({ text, replyToId: "source-message" });
          await pipeline.flush({ force: true });
        }
        return undefined;
      }),
  });

  expect(delivered.map((payload) => payload.text ?? "").join("")).toBe(visible);
  for (const payload of delivered.filter((entry) => entry.text)) {
    expect(payload.replyToId).toBe("source-message");
  }
  expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "final",
      payload: expect.objectContaining({ text: chunks.join("") }),
    }),
  );
});

it.each(["See [", "Example:\n```text\nkeep two spaces  \nkeep a tab\t\n```"])(
  "dispatchReplyFromConfig keeps deferred literal %j in its complete-text fallback",
  async (text) => {
    installCaptionedVoiceTestPlugin("telegram");
    const delivered: Array<{ text?: string; kind: string }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, { kind }) => {
        delivered.push({ text: payload.text, kind });
      },
    });
    await dispatchStream({
      channel: "telegram",
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        await opts?.onBlockReply?.({ text });
        return undefined;
      },
    });
    expect(delivered).toEqual([{ text, kind: "final" }]);
  },
);

it("settles retained followup streams before external cleanup", async () => {
  let retained: GetReplyOptions | undefined;
  const { delivered, dispatcher } = collectingDispatcher();
  const transcript = () => delivered.map((payload) => payload.text ?? "").join("");
  const settled: string[] = [];
  await dispatchStream({
    dispatcher,
    replyOptions: {
      onQueuedFollowupSettled: () => {
        settled.push(transcript());
      },
    },
    replyResolver: async (_ctx, opts) => {
      retained = opts;
      return { text: "initial" };
    },
  });
  for (const text of ["See [", "Intro [[tts:text]]hidden[", "After ["]) {
    await retained?.onBlockReply?.({ text });
    await dispatcher.waitForIdle();
    await retained?.onQueuedFollowupSettled?.();
  }
  expect(transcript()).toBe("initialSee [Intro After [");
  expect(settled).toEqual(["initialSee [", "initialSee [Intro ", "initialSee [Intro After ["]);
});

describe("source completion", () => {
  afterEach(() => vi.restoreAllMocks());
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  const fencedFirst = "```ts\nconst x = \n```";
  const fencedSecond = "```ts\n1;\n```";
  const fencedSource = "```ts\nconst x = 1;\n```";

  type Failure = "before-send" | "ambiguous" | "pending";

  type Scenario = Partial<
    Record<"media" | "priorBracket" | "finalMedia" | "prepared" | "fenced", boolean>
  > & {
    prefix?: Failure;
    suffix?: Failure;
  };
  it.each<[string, Scenario, string[], number]>([
    ["successful suffix", { prepared: true }, ["See ", "["], 1],
    [
      "failed wrapped suffix",
      { fenced: true, suffix: "before-send" },
      [fencedFirst, fencedSecond, "See ", `${fencedSource}\n\nSee [`],
      1,
    ],
    ["pending prefix with final-only media", { prefix: "pending", finalMedia: true }, [], 0],
    [
      "ambiguous media prefix",
      { prefix: "ambiguous", prepared: true, finalMedia: true },
      ["See "],
      0,
    ],
    ["failed suffix with sent media", { suffix: "before-send", media: true }, ["See ", "["], 1],
    ["failed bracket suffix", { suffix: "before-send", priorBracket: true }, ["[", "See ", "["], 1],
  ])(
    "dispatchReplyFromConfig settles %s after producer filtering",
    async (_name, scenario, expected, expectedSuffixCalls) => {
      const actualSessions = scenario.prepared ? await restoreSessionPersistence() : undefined;
      const storePath = path.join(tempDirs.make("openclaw-source-completion-"), "sessions.json");
      const preparedScope = completion(storePath, true);
      const pending = () => actualSessions?.loadSessionEntry(preparedScope)?.pendingFinalDelivery;
      // Fix parser output so this regression isolates source accounting.
      installPartialCleaner();
      const delivered: ReplyPayload[] = [];
      let suffixCalls = 0;
      let sourceStarted = false;
      const dispatcher = createReplyDispatcher({
        deliver: async (payload, { kind }) => {
          const suffix = sourceStarted && kind === "block" && payload.text === "[";
          if (suffix) {
            suffixCalls++;
          }
          const failure =
            kind === "block" && payload.text === "See "
              ? scenario.prefix
              : suffix
                ? scenario.suffix
                : undefined;
          if (failure === "before-send") {
            throw new PlatformMessageNotDispatchedError("fragment was not sent", {
              cause: undefined,
            });
          }
          if (failure === "pending") {
            return {
              visibleReplySent: false,
              suppression: { reason: "adapter_returned_no_identity" },
            };
          }
          delivered.push(payload);
          if (failure === "ambiguous") {
            if (scenario.prepared) {
              return { visibleReplySent: true, ambiguous: true };
            }
            throw new Error("acknowledgement lost after sending");
          }
          return undefined;
        },
      });
      const source: ReplyPayload = {
        text: "See [",
        ...(scenario.media ? { mediaUrl: "https://example.com/image.png" } : {}),
      };
      const result = await dispatchStream({
        dispatcher,
        replyResolver: async (_ctx, options) => {
          if (scenario.priorBracket) {
            await options?.onBlockReply?.({ text: "[" });
            await dispatcher.waitForIdle();
          }
          sourceStarted = true;
          return withStream(options, async (pipeline) => {
            if (scenario.fenced) {
              for (const [text, blockSourceText] of [
                [fencedFirst, "```ts\nconst x = "],
                [fencedSecond, "1;\n```"],
              ]) {
                pipeline.enqueue(withMetadata({ text }, { blockSourceText }));
              }
            }
            pipeline.enqueue(source);
            await pipeline.flush({ force: true });
            if (!scenario.prefix) {
              expect(delivered.at(-1)).toMatchObject({
                text: "See ",
                ...(scenario.media ? { mediaUrl: source.mediaUrl } : {}),
              });
            }
            const finalPayload = {
              ...source,
              text: scenario.fenced ? `${fencedSource}\n\nSee [` : source.text,
              ...(scenario.finalMedia ? { mediaUrl: "https://example.com/final.opus" } : {}),
            };
            if (scenario.finalMedia) {
              withMetadata(finalPayload, {
                pendingFinalDeliveryCompletion: completion(storePath),
              });
            }
            const { replyPayloads } = await buildStreamReplies(finalPayload, pipeline);
            if (actualSessions) {
              withMetadata(expectDefined(replyPayloads[0], "retained final"), {
                pendingFinalDeliveryCompletion: preparedScope,
              });
              await actualSessions.replaceSessionEntry(preparedScope, {
                sessionId: "source-session",
                updatedAt: Date.now(),
                pendingFinalDelivery: {
                  kind: "replayable",
                  text: "See [",
                  createdAt: Date.now(),
                  intentId: "source-intent",
                  deliveries: [{ id: "source-delivery", state: "prepared" }],
                },
              });
              expect(pending()?.deliveries).toEqual([{ id: "source-delivery", state: "prepared" }]);
            }
            await options?.onBlockReply?.({ text: "[" });
            return replyPayloads;
          });
        },
      });
      if (actualSessions) {
        const beforeRecovery = pending();
        if (scenario.prefix === "ambiguous") {
          expect(beforeRecovery?.deliveries).toEqual([{ id: "source-delivery", state: "unknown" }]);
        } else {
          expect(beforeRecovery).toBeUndefined();
        }
        const recovery = await settlePendingFinalDelivery(
          { kind: "pending-final", ...preparedScope },
          "queued",
          ["prepared"],
        );
        expect(recovery.state).toBe("stale");
        expect(pending()).toEqual(beforeRecovery);
      }
      expect(delivered.flatMap((payload) => payload.text ?? [])).toEqual(expected);
      expect(suffixCalls).toBe(expectedSuffixCalls);
      if (scenario.media) {
        expect(delivered.filter((payload) => payload.mediaUrl === source.mediaUrl)).toHaveLength(1);
      }
      if (scenario.finalMedia) {
        expect(delivered).toHaveLength(expected.length + 1);
        const media = delivered.filter(
          (payload) => payload.mediaUrl === "https://example.com/final.opus",
        );
        expect(media).toHaveLength(1);
        expect(result.queuedFinal).toBe(true);
        expect(
          metadata(expectDefined(media[0], "final media"))?.pendingFinalDeliveryCompletion,
        ).toBeUndefined();
      }
    },
  );

  it("dispatchReplyFromConfig reserves a source before concurrent fragment preparation", async () => {
    const prefixPreparing = createDeferred();
    const suffixParsed = createDeferred();
    const releasePrefix = createDeferred();
    installPartialCleaner(suffixParsed.resolve);
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (input: unknown) => {
      const { payload, kind } = input as { payload: ReplyPayload; kind: string };
      if (kind === "block" && payload.text === "See ") {
        prefixPreparing.resolve();
        await releasePrefix.promise;
      }
      return payload;
    });
    const delivered: string[] = [];
    const attempted: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, { kind }) => {
        if (payload.text) {
          attempted.push(payload.text);
        }
        if (kind === "block" && payload.text === "See ") {
          throw new PlatformMessageNotDispatchedError("prefix was not sent", { cause: undefined });
        }
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
    });
    await dispatchStream({
      dispatcher,
      replyResolver: async (_ctx, options) => {
        const pipeline = streamPipeline(options);
        try {
          pipeline.enqueue({ text: "See [" });
          const prefix = pipeline.flush({ force: true });
          await prefixPreparing.promise;
          const suffix = options?.onBlockReply?.({ text: "[" });
          await suffixParsed.promise;
          await nextEventLoopTurn();
          expect(attempted).toEqual([]);
          releasePrefix.resolve();
          await Promise.all([prefix, suffix]);
          const { replyPayloads } = await buildStreamReplies({ text: "See [" }, pipeline);
          return replyPayloads;
        } finally {
          releasePrefix.resolve();
          pipeline.stop();
        }
      },
    });
    expect(attempted).toEqual(["See ", "See ["]);
    expect(delivered).toEqual(["See ["]);
  });
});
