import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelProgressDraftCompositor,
  createLivePreviewLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import { deliverMattermostReplyWithDraftPreview } from "./monitor-draft-delivery.js";

type RequestRecord = Parameters<MattermostClient["request"]>;

type StreamOptions = Parameters<typeof createMattermostDraftStream>[0];
type DraftStreamOptions = Omit<StreamOptions, "client" | "channelId"> & {
  beforeDelete?: (id: string) => Promise<void>;
  beforeRequest?: (path: string) => Promise<void>;
};

function createDraftStreamFixture(options: DraftStreamOptions = {}) {
  const { beforeDelete, beforeRequest, ...streamOptions } = options;
  const posts = new Map<string, string>();
  let nextId = 1;
  const requestImpl: MattermostClient["request"] = async <T>(path: string, init?: RequestInit) => {
    if (beforeRequest) {
      await beforeRequest(path);
    }
    const creating = path === "/posts" && init?.method === "POST";
    const id = creating ? `post-${nextId++}` : path.slice("/posts/".length).replace(/\/patch$/, "");
    if (init?.method === "DELETE") {
      await beforeDelete?.(id);
      posts.delete(id);
      return undefined as T;
    }
    if (creating || init?.method === "PUT") {
      if (!creating && !posts.has(id)) {
        throw new Error("Mattermost API 404 Not Found");
      }
      const message = String(parseRequestJson(init).message);
      posts.set(id, message);
      return { id, message } as T;
    }
    throw new Error(`Unexpected Mattermost request: ${init?.method} ${path}`);
  };
  const requestMock = vi.fn(requestImpl);
  const client: MattermostClient = {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: requestMock as MattermostClient["request"],
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
  const stream = createMattermostDraftStream({
    client,
    channelId: "channel-1",
    throttleMs: 0,
    ...streamOptions,
  });
  return { client, calls: requestMock.mock.calls, requestMock, stream, posts };
}

type Stream = ReturnType<typeof createMattermostDraftStream>;
async function publish(stream: Stream, text: string, assistant = false) {
  (assistant ? stream.updateAssistantText : stream.update)(text);
  await stream.flush();
}

async function published(text: string, options: DraftStreamOptions = {}, assistant = false) {
  const fixture = createDraftStreamFixture(options);
  await publish(fixture.stream, text, assistant);
  return fixture;
}

function requests(calls: RequestRecord[]) {
  return calls.map(([path, init]) => [path, init?.method, parseRequestJson(init).message]);
}

function expectFinalText(
  stream: Stream,
  text: string,
  kind: "full" | "remaining" | "already-delivered",
  remaining = text,
) {
  expect(stream.resolveFinalText(text)).toEqual({
    kind,
    ...(kind === "already-delivered" ? {} : { text: remaining }),
    publishedParts: [{ messageId: "post-1", content: "First block" }],
  });
}

function parseRequestJson(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON request body");
  }
  const parsed: unknown = JSON.parse(init.body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

function deletionFailure(retryFails = false) {
  const warn = vi.fn();
  const deleteAttempts: string[] = [];
  const fixture = createDraftStreamFixture({
    warn,
    beforeDelete: async (id) => {
      deleteAttempts.push(id);
      if (deleteAttempts.length === 1 || retryFails) {
        throw new Error("temporary delete failure");
      }
    },
  });
  return { ...fixture, warn, deleteAttempts };
}

it("creates a preview post and updates it on later changes", async () => {
  const { calls, stream } = await published("Running `read`…", { rootId: "root-1" });
  await publish(stream, "Running `read`…");

  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("/posts");

  expect(parseRequestJson(calls[0]?.[1])).toEqual({
    channel_id: "channel-1",
    root_id: "root-1",
    message: "Running `read`…",
  });
  expect(stream.postId()).toBe("post-1");
});

it.each(["immediate", "pending deletion", "pending publication"])(
  "keeps the identical plan replacement (%s)",
  async (timing) => {
    const delayFirstPublication = timing === "pending publication";
    const deleteStarted = createDeferred<void>();
    const releaseDelete = createDeferred<void>();
    const firstPublicationVisible = createDeferred<void>();
    const releaseFirstPublication = createDeferred<void>();
    let firstUpdate = true;
    const { stream, posts } = createDraftStreamFixture({
      beforeDelete: async () => {
        deleteStarted.resolve();
        await releaseDelete.promise;
      },
    });
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      mode: "progress",
      active: true,
      seed: "plan-retraction",
      update: async (text, options) => {
        const delayCompletion = firstUpdate && delayFirstPublication;
        firstUpdate = false;
        stream.update(text);
        if (options?.flush) {
          await stream.flush();
        }
        if (delayCompletion) {
          firstPublicationVisible.resolve();
          await releaseFirstPublication.promise;
        }
      },
      deleteCurrent: () => stream.deleteCurrentMessage(),
    });
    let firstPublication: Promise<boolean> | undefined;
    let retraction: Promise<boolean> | undefined;
    let replacementPublication: Promise<boolean> | undefined;
    const plan = [{ step: "Inspect", status: "in_progress" as const }];
    try {
      firstPublication = progress.pushPlanProgress(plan);
      await (delayFirstPublication ? firstPublicationVisible.promise : firstPublication);
      expect([...posts.values()]).toEqual([expect.stringContaining("Inspect")]);

      retraction = progress.pushPlanProgress([]);
      if (timing !== "immediate") {
        await deleteStarted.promise;
      }
      if (delayFirstPublication) {
        releaseFirstPublication.resolve();
        await firstPublication;
      }
      replacementPublication = progress.pushPlanProgress(plan);
      await deleteStarted.promise;
      releaseDelete.resolve();
      await Promise.all([retraction, replacementPublication]);
      await stream.flush();

      expect([...posts.values()]).toEqual([expect.stringContaining("Inspect")]);
      expect(posts.has(stream.postId() ?? "")).toBe(true);
    } finally {
      releaseFirstPublication.resolve();
      releaseDelete.resolve();
      await Promise.allSettled([firstPublication, retraction, replacementPublication]);
      progress.cancel();
      await stream.clear();
    }
  },
);

it.each([false, true])(
  "retries retired preview cleanup at stop while preserving the final (retry fails: %s)",
  async (retryFails) => {
    const { client, stream, posts, warn, deleteAttempts } = deletionFailure(retryFails);
    const deliverPayload = vi.fn(async () => {
      throw new Error("the final should edit its preview in place");
    });
    try {
      await publish(stream, "Retired plan");
      const retiredId = stream.postId();
      await stream.deleteCurrentMessage();
      await publish(stream, "Replacement plan");
      const finalId = stream.postId();
      const result = await deliverMattermostReplyWithDraftPreview({
        payload: { text: "Final answer" },
        info: { kind: "final" },
        kind: "direct",
        client,
        previewLifecycle: createLivePreviewLifecycle<ReplyPayload, string>({
          draft: { ...stream, id: stream.postId },
        }),
        resolvePreviewFinalText: (text) => ({ editText: text, alreadyDelivered: false }),
        logVerboseMessage: vi.fn(),
        deliverPayload,
      });
      expect(result.visibleReplySent).toBe(true);
      expect(result.messageIds).toEqual([finalId]);
      expect(posts.get(finalId ?? "")).toBe("Final answer");
      expect(deliverPayload).not.toHaveBeenCalled();

      await stream.stop();

      expect(posts.get(finalId ?? "")).toBe("Final answer");
      expect(deleteAttempts).not.toContain(finalId);
      expect(deleteAttempts).toEqual([retiredId, retiredId]);
      expect(warn).toHaveBeenCalledTimes(retryFails ? 2 : 1);
      expect(warn).toHaveBeenCalledWith(
        "mattermost stream preview cleanup failed: temporary delete failure",
      );
      expect([...posts.values()]).toEqual(
        retryFails ? ["Retired plan", "Final answer"] : ["Final answer"],
      );
    } finally {
      await stream.seal();
    }
  },
);

it("retains a failed current-post deletion across stop until another clear", async () => {
  const { stream, posts, warn, deleteAttempts } = deletionFailure();
  try {
    await publish(stream, "Current preview");
    const currentId = stream.postId();
    await stream.clear();
    await stream.stop();
    expect(stream.postId()).toBe(currentId);
    expect([...posts.values()]).toEqual(["Current preview"]);
    expect(deleteAttempts).toEqual([currentId]);
    expect(warn).toHaveBeenCalledTimes(1);

    await stream.clear();
    expect(posts.size).toBe(0);
    expect(deleteAttempts).toEqual([currentId, currentId]);
  } finally {
    await stream.seal();
  }
});

it.each(["seal", "stop"] as const)(
  "%s preserves the post and ignores later updates",
  async (end) => {
    const { calls, stream } = await published("Working...", {
      rootId: "root-1",
      throttleMs: 1000,
    });
    stream.update("Stale partial");
    await stream[end]();
    stream.update("Late partial");
    await stream.flush();
    await stream.forceNewMessage();
    expect(calls).toHaveLength(end === "seal" ? 1 : 2);
    expect(calls[0]?.[0]).toBe("/posts");
    expect(stream.postId()).toBe("post-1");
    if (end === "stop") {
      expect(calls[1]?.[0]).toBe("/posts/post-1/patch");
      expect(parseRequestJson(calls[1]?.[1])).toEqual({
        id: "post-1",
        message: "Stale partial",
      });
    }
  },
);

it("retains an accepted preview failure after its background flush has settled", async () => {
  const warn = vi.fn();
  const { requestMock, stream } = createDraftStreamFixture({ warn });
  requestMock.mockResolvedValueOnce({ message: "already visible" });

  stream.update("Already delivered");
  await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

  await expect(stream.flush()).rejects.toSatisfy(isChannelPartialDeliveryError);
  expect(requestMock).toHaveBeenCalledOnce();
  expect(requestMock.mock.calls[0]?.[0]).toBe("/posts");
  stream.update("Must not create another accepted post");
  await expect(stream.flush()).rejects.toThrow("did not include a post id");
  expect(requestMock).toHaveBeenCalledOnce();
  const finishers = [
    stream.discardPending,
    stream.clear,
    stream.seal,
    stream.stop,
    stream.forceNewMessage,
    stream.settleBoundaries,
  ];
  for (const finish of finishers) {
    await expect(finish()).rejects.toThrow("did not include a post id");
  }
  expect(requestMock).toHaveBeenCalledOnce();
});

it("truncates on a code-point boundary so a straddling emoji is dropped whole", async () => {
  // The cut point (9) straddles the emoji at UTF-16 indices 8-9.
  const input = `${"a".repeat(8)}\u{1F600}${"b".repeat(5)}`;
  const { calls } = await published(input, { maxChars: 12 });

  expect(calls).toHaveLength(1);
  expect(parseRequestJson(calls[0]?.[1]).message).toBe("aaaaaaaa...");
});

it("does not resend after an update failure followed by stop", async () => {
  const warn = vi.fn();
  const { requestMock, stream } = await published("Working...", { throttleMs: 1000, warn });
  requestMock.mockRejectedValueOnce(new Error("patch failed"));
  await publish(stream, "Will fail");
  await stream.stop();

  expect(warn).toHaveBeenCalledWith("mattermost stream preview failed: patch failed");
  expect(requestMock.mock.calls.map(([path]) => path)).toEqual(["/posts", "/posts/post-1/patch"]);
});
it("propagates an accepted background failure that settles during boundary rotation", async () => {
  const { requestMock, stream } = createDraftStreamFixture();
  const createReady = createDeferred<void>();
  requestMock.mockImplementationOnce(async () => {
    await createReady.promise;
    return { message: "already visible" };
  });

  stream.update("Accepted background preview");
  await vi.waitFor(() => expect(requestMock).toHaveBeenCalledOnce());
  const boundary = stream.forceNewMessage();
  createReady.resolve();

  await expect(boundary).rejects.toThrow("did not include a post id");
  await expect(stream.flush()).rejects.toThrow("did not include a post id");
  expect(requestMock).toHaveBeenCalledOnce();
});

it("restores and chunks an already-flushed over-limit block before rotating", async () => {
  const firstChunk = "a".repeat(10);
  const secondChunk = "b".repeat(10);
  const chunkText = vi.fn(() => [firstChunk, secondChunk]);
  const { calls, stream } = await published(`${firstChunk}${secondChunk}`, {
    maxChars: 10,
    chunkText,
  });
  expect(parseRequestJson(calls[0]?.[1])?.message).toBe("aaaaaaa...");

  await stream.forceNewMessage();
  expect(stream.postId()).toBeUndefined();
  await publish(stream, "tool");

  expect(requests(calls)).toEqual([
    ["/posts", "POST", "aaaaaaa..."],
    ["/posts/post-1/patch", "PUT", firstChunk],
    ["/posts", "POST", secondChunk],
    ["/posts", "POST", "tool"],
  ]);
  expect(chunkText).toHaveBeenCalledWith(`${firstChunk}${secondChunk}`);
  expect(stream.postId()).toBe("post-3");
});

it("publishes overlapping fire-and-forget boundaries in generation order", async () => {
  const firstCreate = createDeferred<void>();
  const boundaryPatch = createDeferred<void>();
  const secondCreate = createDeferred<void>();
  let createdCount = 0;
  const { stream, calls } = createDraftStreamFixture({
    beforeRequest: (path) => {
      const pause = path === "/posts" ? [firstCreate, secondCreate][createdCount++] : boundaryPatch;
      return pause?.promise ?? Promise.resolve();
    },
  });

  stream.update("tool start");
  stream.update("tool complete");
  const firstBoundary = stream.forceNewMessage();
  stream.update("assistant progress");
  const secondBoundary = stream.forceNewMessage();
  stream.update("final answer");
  const flush = stream.flush();
  firstCreate.resolve();

  await vi.waitFor(() => {
    expect(calls.map(([path]) => path)).toEqual(["/posts", "/posts/post-1/patch"]);
  });
  boundaryPatch.resolve();
  await vi.waitFor(() => {
    expect(calls.map(([path]) => path)).toEqual(["/posts", "/posts/post-1/patch", "/posts"]);
  });
  secondCreate.resolve();
  await Promise.all([firstBoundary, secondBoundary, flush]);

  expect(requests(calls)).toEqual([
    ["/posts", "POST", "tool start"],
    ["/posts/post-1/patch", "PUT", "tool complete"],
    ["/posts", "POST", "assistant progress"],
    ["/posts", "POST", "final answer"],
  ]);
  expect(stream.postId()).toBe("post-3");
});

it("resolves a cumulative terminal reply to the current confirmed generation", async () => {
  const { stream } = await published("First block", {}, true);
  await stream.forceNewMessage();
  await publish(stream, "Second block", true);

  const final = "Second block complete";
  expectFinalText(stream, `First block\n\n${final}`, "remaining", final);
  expectFinalText(stream, final, "full");
  expectFinalText(stream, "First block extended", "full");
});

it("strips confirmed assistant blocks but not transient progress generations", async () => {
  const { stream } = await published("First block", {}, true);
  await stream.forceNewMessage();
  await publish(stream, "Running tool…");
  await stream.forceNewMessage();
  await stream.settleBoundaries();

  expectFinalText(stream, "First block\n\nFinal after tool", "remaining", "Final after tool");
  expectFinalText(stream, "First block extended", "full");
  expectFinalText(stream, "First block", "already-delivered");
  expectFinalText(stream, "", "full");
});

it("keeps the canonical final when an assistant boundary fails to publish", async () => {
  const { requestMock, stream } = await published("First block", {}, true);
  requestMock.mockRejectedValueOnce(new Error("boundary failed"));
  stream.updateAssistantText("First block complete");
  await stream.forceNewMessage();

  const finalText = "First block complete\n\nFinal after failure";
  expectFinalText(stream, finalText, "remaining", "complete\n\nFinal after failure");
});

it("does not strip a requested prefix rewritten by the provider", async () => {
  const { requestMock, stream } = createDraftStreamFixture({
    chunkText: () => ["First half", "Second half"],
  });

  await publish(stream, "First half Second half", true);
  requestMock
    .mockResolvedValueOnce({ id: "post-1", message: "Provider rewrite" })
    .mockRejectedValueOnce(new Error("second chunk failed"));
  await stream.forceNewMessage();

  const finalText = "First half Second half\n\nFinal after failure";
  expect(stream.resolveFinalText(finalText)).toEqual({
    kind: "full",
    text: finalText,
    publishedParts: [{ messageId: "post-1", content: "Provider rewrite" }],
  });
});

it("publishes the known prefix before an IDless failure warning re-enters", async () => {
  const finalText = "First Second Third\n\nFinal after failure";
  let resolutionAtWarning: unknown;
  let reenteredBoundary: Promise<void> | undefined;
  const warn = vi.fn(() => {
    resolutionAtWarning = stream.resolveFinalText(finalText);
    stream.update("must not publish twice");
    reenteredBoundary = stream.forceNewMessage();
    void reenteredBoundary.catch(() => {});
  });
  const { requestMock, stream } = createDraftStreamFixture({
    chunkText: () => ["First", "Second", "Third"],
    warn,
  });

  await publish(stream, "First Second Third", true);
  requestMock
    .mockResolvedValueOnce({ id: "post-1", message: "First" })
    .mockResolvedValueOnce({ id: "post-2", message: "Second" })
    .mockResolvedValueOnce({ message: "Third" });

  await expect(stream.forceNewMessage()).rejects.toThrow("did not include a post id");
  await expect(reenteredBoundary).rejects.toThrow("did not include a post id");

  const expectedResolution = {
    kind: "remaining",
    text: "Third\n\nFinal after failure",
    publishedParts: [
      { messageId: "post-1", content: "First" },
      { messageId: "post-2", content: "Second" },
    ],
  };
  expect(warn).toHaveBeenCalledOnce();
  expect(resolutionAtWarning).toEqual(expectedResolution);
  expect(stream.resolveFinalText(finalText)).toEqual(expectedResolution);
  expect(requests(requestMock.mock.calls)).toEqual([
    ["/posts", "POST", "First Second Third"],
    ["/posts/post-1/patch", "PUT", "First"],
    ["/posts", "POST", "Second"],
    ["/posts", "POST", "Third"],
  ]);
});
