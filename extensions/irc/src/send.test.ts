import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { createSendCfgThreadingRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IrcClient } from "./client.js";
import * as ircRuntime from "./runtime.js";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => {
  const loadConfig = vi.fn();
  const resolveMarkdownTableMode = vi.fn(() => "preserve");
  const convertMarkdownTables = vi.fn((text: string) => text);
  const stripMarkdown = vi.fn((text: string) => text);
  const record = vi.fn();
  const buildIrcConnectOptions = vi.fn(
    (_account: unknown, overrides: Record<string, unknown> = {}) => overrides,
  );
  return {
    loadConfig,
    resolveMarkdownTableMode,
    convertMarkdownTables,
    stripMarkdown,
    record,
    connectIrcClient: vi.fn(),
    buildIrcConnectOptions,
  };
});

vi.mock("./client.js", () => ({
  connectIrcClient: hoisted.connectIrcClient,
}));

vi.mock("./connect-options.js", () => ({
  buildIrcConnectOptions: hoisted.buildIrcConnectOptions,
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => "irc-msg-1",
  };
});

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/markdown-table-runtime")) as Record<
    string,
    unknown
  >;
  return {
    ...original,
    resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
  };
});

vi.mock("openclaw/plugin-sdk/text-chunking", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/text-chunking")) as Record<
    string,
    unknown
  >;
  return {
    ...original,
    convertMarkdownTables: hoisted.convertMarkdownTables,
    stripMarkdown: hoisted.stripMarkdown,
  };
});

import { ircMessageAdapter, sendFormattedIrcText } from "./message-adapter.js";
import { ircOutboundBaseAdapter } from "./outbound-base.js";
import { sendIrcMessages, sendMessageIrc } from "./send.js";

function resetHoistedMocks() {
  hoisted.loadConfig.mockReset();
  hoisted.resolveMarkdownTableMode.mockReset().mockReturnValue("preserve");
  hoisted.convertMarkdownTables.mockReset().mockImplementation((text: string) => text);
  hoisted.stripMarkdown.mockReset().mockImplementation((text: string) => text);
  hoisted.record.mockReset();
  hoisted.connectIrcClient.mockReset();
  hoisted.buildIrcConnectOptions.mockReset().mockReturnValue({});
}

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./connect-options.js");
  vi.doUnmock("node:crypto");
  vi.doUnmock("openclaw/plugin-sdk/markdown-table-runtime");
  vi.doUnmock("openclaw/plugin-sdk/text-chunking");
  vi.resetModules();
});

const providedCfg: CoreConfig = {
  channels: { irc: { host: "irc.example.com", nick: "openclaw" } },
};

function createClient(isReady = () => true) {
  return {
    nick: "openclaw",
    isReady: vi.fn(isReady),
    sendRaw: vi.fn(),
    join: vi.fn(),
    sendPrivmsg: vi.fn(),
    quit: vi.fn(),
    close: vi.fn(),
  } satisfies IrcClient;
}

describe("sendMessageIrc cfg threading", () => {
  beforeEach(() => {
    resetHoistedMocks();
    ircRuntime.setIrcRuntime(createSendCfgThreadingRuntime(hoisted) as never);
  });

  it("rejects stripped-empty replies before adding reply metadata", async () => {
    const client = createClient();
    hoisted.stripMarkdown.mockReturnValue("");

    await expect(
      sendMessageIrc("#room", "#", {
        cfg: providedCfg,
        client,
        replyTo: "irc-parent-1",
      }),
    ).rejects.toThrow("Message must be non-empty for IRC sends");

    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(hoisted.record).not.toHaveBeenCalled();
  });

  it("uses one transient connection for a chunked outbound message", async () => {
    const client = createClient();
    hoisted.connectIrcClient.mockResolvedValue(client);
    const onDeliveryResult = vi.fn();
    const onPlatformSendDispatch = vi.fn();
    const text = Array.from({ length: 80 }, (_, index) => `word-${index}`).join(" ");
    const chunks = ircOutboundBaseAdapter.chunker(text, 350);

    const results = await sendFormattedIrcText({
      cfg: providedCfg,
      to: "#room",
      text,
      replyToId: "parent-1",
      replyToIdSource: "explicit",
      replyToMode: "all",
      onDeliveryResult,
      onPlatformSendDispatch,
    });

    expect(hoisted.connectIrcClient).toHaveBeenCalledOnce();
    expect(client.join).toHaveBeenCalledOnce();
    expect(client.sendPrivmsg.mock.calls).toEqual(
      chunks.map((chunk) => ["#room", chunk, "parent-1"]),
    );
    expect(client.quit).toHaveBeenCalledOnce();
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(chunks.length);
    expect(onDeliveryResult).toHaveBeenCalledTimes(chunks.length);
    expect(results).toHaveLength(chunks.length);
  });

  it.each([
    { kind: "formatted", sendMessage: sendFormattedIrcText, phase: "connect" },
    { kind: "formatted", sendMessage: sendFormattedIrcText, phase: "dispatch" },
    { kind: "text", sendMessage: ircMessageAdapter.send.text, phase: "connect" },
  ])("cancels $kind sends during $phase", async ({ sendMessage, phase }) => {
    const client = createClient();
    let resolveConnect!: (client: IrcClient) => void;
    const connect = new Promise<IrcClient>((resolve) => {
      resolveConnect = resolve;
    });
    hoisted.buildIrcConnectOptions.mockImplementation((_account, overrides = {}) => overrides);
    hoisted.connectIrcClient.mockReturnValue(connect);
    const abortController = new AbortController();

    const onPlatformSendDispatch = vi.fn(async () => {
      await Promise.resolve();
      abortController.abort();
    });
    const send = sendMessage({
      cfg: providedCfg,
      to: "#room",
      text: "hello",
      mediaUrl: "https://example.com/image.png",
      signal: abortController.signal,
      abortSignal: abortController.signal,
      onPlatformSendDispatch,
    });
    await vi.waitFor(() => expect(hoisted.connectIrcClient).toHaveBeenCalledOnce());
    if (phase === "connect") {
      abortController.abort();
    }
    resolveConnect(client);

    await expect(send).rejects.toMatchObject({ name: "AbortError" });
    expect(hoisted.buildIrcConnectOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    expect(client.join).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it("stops before recording another chunk after the connection closes", async () => {
    let ready = true;
    const client = createClient(() => ready);
    hoisted.connectIrcClient.mockResolvedValue(client);
    const onDeliveryResult = vi.fn(() => {
      ready = false;
    });
    const onPlatformSendDispatch = vi.fn();
    const text = Array.from({ length: 80 }, (_, index) => `word-${index}`).join(" ");

    await expect(
      sendFormattedIrcText({
        cfg: providedCfg,
        to: "#room",
        text,
        onDeliveryResult,
        onPlatformSendDispatch,
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      message: "IRC connection closed before send",
      deliveryResult: { messageIds: ["irc-msg-1"], visibleReplySent: true },
    });

    expect(client.sendPrivmsg).toHaveBeenCalledOnce();
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it("retains accepted receipts when a later partial-send fails", async () => {
    const client = createClient();
    const cause = new Error("send interrupted");
    const failure = createChannelPartialDeliveryError(cause, {
      messageIds: ["nested-id"],
      visibleReplySent: true,
    });
    client.sendPrivmsg.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);

    await expect(
      sendIrcMessages("#room", "first second", { cfg: providedCfg, client }, () => [
        { text: "first" },
        { text: "second" },
      ]),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: failure,
      deliveryResult: {
        messageIds: ["irc-msg-1", "nested-id"],
        visibleReplySent: true,
        receipt: {
          platformMessageIds: ["irc-msg-1", "nested-id"],
        },
      },
    });
  });

  it("declares message adapter durable text, media, and reply with receipt proofs", async () => {
    const client = createClient();
    hoisted.connectIrcClient.mockResolvedValue(client);

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "irc",
      adapter: ircMessageAdapter,
      proofs: {
        text: async () => {
          const result = await ircMessageAdapter.send?.text?.({
            cfg: providedCfg,
            to: "#room",
            text: "hello",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["irc-msg-1"]);
          expect(result?.target).toEqual({ kind: "conversation", id: "#room" });
          expect(client.join).toHaveBeenCalledWith("#room");
          expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello", undefined);
        },
        media: async () => {
          const result = await ircMessageAdapter.send?.media?.({
            cfg: providedCfg,
            to: "#room",
            text: "image",
            mediaUrl: "https://example.com/image.png",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["irc-msg-1"]);
          expect(client.join).toHaveBeenCalledWith("#room");
          expect(client.sendPrivmsg).toHaveBeenCalledWith(
            "#room",
            "image\n\nAttachment: https://example.com/image.png",
            undefined,
          );
        },
        replyTo: async () => {
          const result = await ircMessageAdapter.send?.text?.({
            cfg: providedCfg,
            to: "#room",
            text: "threaded",
            replyToId: "parent-1",
          });
          expect(result?.receipt.replyToId).toBe("parent-1");
          expect(client.join).toHaveBeenCalledWith("#room");
          expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "threaded", "parent-1");
        },
      },
    });

    expect(proofResults.find((result) => result.capability === "text")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "media")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "replyTo")?.status).toBe("verified");
  });
});
