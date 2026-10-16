// Feishu tests cover comment dispatcher plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuRuntimeAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const createReplyPrefixContextMock = vi.hoisted(() => vi.fn());
const typingMock = vi.hoisted(() => vi.fn());
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "private.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return { hostname, addresses: ["93.184.216.34"], lookup: vi.fn() };
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

vi.mock("./accounts.js", () => ({ resolveFeishuRuntimeAccount: resolveFeishuRuntimeAccountMock }));
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>()),
  createReplyPrefixContext: createReplyPrefixContextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  createCommentTypingReactionLifecycle: typingMock,
}));
vi.mock("./drive.js", () => ({ deliverCommentThreadText: deliverCommentThreadTextMock }));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
import { createFeishuCommentReplyDispatcher } from "./comment-dispatcher.js";

const commandAction = (command: string) => ({ type: "command" as const, command });
const buttons = (
  label: string,
  action: ReturnType<typeof commandAction> | { type: "url"; url: string },
) => ({
  blocks: [{ type: "buttons" as const, buttons: [{ label, action }] }],
});
const approve = buttons("Approve", commandAction("/approve req_1"));
const unavailable =
  "\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.";
const approveText = "- Approve: `/approve req_1`" + unavailable;

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

describe("createFeishuCommentReplyDispatcher", () => {
  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-outbound");
    vi.doUnmock("./comment-reaction.js");
    vi.doUnmock("./drive.js");
    vi.doUnmock("./runtime.js");
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  function createTestCommentReplyDispatcher() {
    return createFeishuCommentReplyDispatcher({
      cfg: {} as never,
      agentId: "main",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      accountId: "main",
      fileToken: "doc_token_1",
      fileType: "docx",
      commentId: "comment_1",
      replyId: "reply_1",
      isWholeComment: false,
    });
  }

  function mockTextRuntime(chunks?: string[]) {
    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => (chunks ? 4 : 4000)),
          resolveChunkMode: vi.fn(() => "line"),
          chunkTextWithMode: vi.fn((text: string) => chunks ?? [text]),
        },
        reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuRuntimeAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {},
    });
    createFeishuClientMock.mockReturnValue({});
    createReplyPrefixContextMock.mockReturnValue({
      responsePrefix: undefined,
      responsePrefixContextProvider: undefined,
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "reply_1",
    });
    typingMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup: vi.fn(async () => {}),
    });
    mockTextRuntime();
  });

  it("sends final comment text without waiting for typing cleanup", async () => {
    const { promise: cleanupPromise, resolve: resolveCleanup } = Promise.withResolvers<void>();
    const cleanup = vi.fn(() => cleanupPromise);
    typingMock.mockReturnValue({ start: vi.fn(async () => {}), cleanup });

    const created = createTestCommentReplyDispatcher();
    const deliverPromise = Promise.resolve(
      created.delivery.deliver({ text: "hello world" }, { kind: "final" }),
    );
    const status = await raceWithNextMacrotask(deliverPromise.then(() => "done"));

    expect(status).toBe("done");
    const client = createFeishuClientMock.mock.results[0]?.value;
    if (!client) {
      throw new Error("Expected Feishu client");
    }
    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(client, {
      file_token: "doc_token_1",
      file_type: "docx",
      comment_id: "comment_1",
      content: "hello world",
      is_whole_comment: false,
    });
    expect(cleanup).not.toHaveBeenCalled();

    created.dispatcherOptions.onCleanup?.();
    expect(cleanup).toHaveBeenCalledTimes(1);

    resolveCleanup();
    await deliverPromise;
  });

  it("does not send whitespace-only comment replies without attachments", async () => {
    const created = createTestCommentReplyDispatcher();
    const result = await created.delivery.deliver({ text: "  \n\t " }, { kind: "final" });

    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ visibleReplySent: false });
  });

  it.each([
    [
      "caption, actionable presentation, and safe attachment",
      {
        text: "Review this",
        mediaUrl: "https://example.com/attachment.png",
        presentation: approve,
      },
      "Review this\n\n" + approveText + "\n\nhttps://example.com/attachment.png",
    ],
    ["legacy interactive command", { interactive: approve }, approveText],
    [
      "select option with an actionable command",
      {
        presentation: {
          blocks: [
            {
              type: "select" as const,
              placeholder: "Choose deployment",
              options: [{ label: "Deploy", action: commandAction("/deploy staging") }],
            },
          ],
        },
      },
      "Choose deployment:\n- Deploy: `/deploy staging`" + unavailable,
    ],
    [
      "URL-only button without actionable guidance",
      {
        presentation: buttons("Open", { type: "url", url: "https://example.com/action" }),
      },
      "- Open: https://example.com/action",
    ],
  ])("delivers %s as safe plain-text comment links", async (_label, payload, expected) => {
    const created = createTestCommentReplyDispatcher();
    const result = await created.delivery.deliver(payload, { kind: "final" });
    expectDelivered(result, expected);
  });

  it.each([
    ["local path", "/private/tmp/voice.mp3"],
    ["loopback URL", "http://127.0.0.1:3000/voice.mp3"],
    ["private DNS", "https://private.example.test/voice.mp3"],
    ["credentialed URL", "https://operator:secret@example.com/voice.mp3"],
  ])("does not disclose a %s in comment reply media fallbacks", async (_label, mediaUrl) => {
    const created = createTestCommentReplyDispatcher();
    const result = await created.delivery.deliver({ mediaUrl }, { kind: "final" });
    expectDelivered(result, "Media upload failed. Please try again.");
    expect(deliverCommentThreadTextMock.mock.calls[0]?.[1]?.content).not.toContain(mediaUrl);
  });

  it("retains the accepted comment reply id and text when a later chunk fails", async () => {
    mockTextRuntime(["first", "second"]);
    deliverCommentThreadTextMock
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_native_1" })
      .mockRejectedValueOnce(new Error("second comment send failed"));
    const created = createTestCommentReplyDispatcher();

    const error = await created.delivery
      .deliver({ text: "firstsecond" }, { kind: "final" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { messageIds: ["reply_native_1"], content: "first", visibleReplySent: true },
    });
  });
});

function expectDelivered(result: unknown, content: string) {
  expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ content }),
  );
  expect(result).toMatchObject({ content, visibleReplySent: true });
}
