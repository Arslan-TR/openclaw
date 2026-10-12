// Ollama tests cover stream plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  buildAssistantMessage,
  createOllamaStreamFn,
  isOllamaCompatProvider,
} from "./stream-api.js";

function makeOllamaResponse(params: {
  content?: string;
  thinking?: string;
  reasoning?: string;
  done_reason?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}) {
  return {
    model: "qwen3.5",
    created_at: new Date().toISOString(),
    message: {
      role: "assistant" as const,
      content: params.content ?? "",
      ...(params.thinking != null ? { thinking: params.thinking } : {}),
      ...(params.reasoning != null ? { reasoning: params.reasoning } : {}),
      ...(params.tool_calls ? { tool_calls: params.tool_calls } : {}),
    },
    done: true,
    ...(params.done_reason ? { done_reason: params.done_reason } : {}),
    prompt_eval_count: 100,
    eval_count: 50,
  };
}

const MODEL_INFO = { api: "ollama", provider: "ollama", id: "qwen3.5" };
const STREAM_MODEL = {
  api: "ollama",
  provider: "ollama",
  id: "qwen3.5",
  input: ["text"],
  contextWindow: 65536,
} as const;

describe("isOllamaCompatProvider", () => {
  it.each([
    ["http://localhost:11434", true],
    ["http://127.0.0.1.evil.com:11434", false],
  ] as const)("classifies %s as Ollama-compatible=%s", (baseUrl, expected) => {
    expect(isOllamaCompatProvider({ provider: "custom", baseUrl })).toBe(expected);
  });
});

describe("buildAssistantMessage", () => {
  it("keeps a length stop authoritative over complete-looking tool calls", () => {
    const response = makeOllamaResponse({
      done_reason: "length",
      tool_calls: [{ function: { name: "read", arguments: { path: "README.md" } } }],
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.stopReason).toBe("length");
  });

  it("anchors context usage on measured prompt and output including cached tokens", () => {
    const response = {
      ...makeOllamaResponse({ content: "ok" }),
      prompt_eval_cached_count: 80,
    };
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.usage).toMatchObject({
      input: 20,
      cacheRead: 80,
      contextUsage: { state: "available", promptTokens: 100, totalTokens: 150 },
    });
  });

  it("omits context usage when the output counter is missing", () => {
    const response: Parameters<typeof buildAssistantMessage>[0] = {
      model: "qwen3.5",
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: "ok" },
      done: true,
      prompt_eval_count: 100,
    };
    const msg = buildAssistantMessage(response, MODEL_INFO, { input: 321, output: 123 });
    expect(msg.usage.contextUsage).toBeUndefined();
  });
});

describe("createOllamaStreamFn thinking events", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.useRealTimers();
  });

  function makeNdjsonBody(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const lines = chunks.map((c) => JSON.stringify(c) + "\n").join("");
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines));
        controller.close();
      },
    });
  }

  async function streamOllamaEvents(
    chunks: Array<Record<string, unknown>>,
    options: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] = {},
    context: Parameters<ReturnType<typeof createOllamaStreamFn>>[1] = {
      messages: [{ role: "user", content: "test" }],
    } as never,
  ): Promise<Array<{ type: string; [key: string]: unknown }>> {
    const body = makeNdjsonBody(chunks);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(STREAM_MODEL as never, context, options);

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      [key: string]: unknown;
    }>) {
      events.push(event);
    }
    return events;
  }

  it.each(["Private reasoning"])(
    "keeps native tool narration unsigned with reasoning %s",
    async (thinking) => {
      const path = "README.md";
      const events = await streamOllamaEvents(
        [
          { ...makeOllamaResponse({ content: "Let me ", thinking }), done: false },
          { ...makeOllamaResponse({ content: "read README.md." }), done: false },
          makeOllamaResponse({
            tool_calls: [{ function: { name: "read", arguments: { path } } }],
          }),
        ],
        {},
        {
          messages: [{ role: "user", content: "Read README.md." }],
          tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
        } as never,
      );
      const done = events.find((event) => event.type === "done") as {
        message?: { content?: unknown };
      };
      expect(
        events
          .filter((event) => event.type === "text_delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe("Let me read README.md.");
      expect(events.find((event) => event.type === "toolcall_delta")).toMatchObject({
        partial: {
          content: expect.arrayContaining([
            expect.objectContaining({ partialJson: JSON.stringify({ path }) }),
          ]),
        },
      });
      expect(done.message?.content).toEqual([
        ...(thinking ? [{ type: "thinking", thinking: "Private reasoning" }] : []),
        { type: "text", text: "Let me read README.md." },
        { type: "toolCall", id: expect.any(String), name: "read", arguments: { path } },
      ]);
    },
  );

  it.each(["length"])(
    "keeps text before reasoning deliverable at a %s terminal",
    async (done_reason) => {
      const events = await streamOllamaEvents([
        { ...makeOllamaResponse({ content: "Visible answer" }), done: false },
        makeOllamaResponse({ thinking: "Late reasoning", done_reason }),
      ]);
      expect(events.find((event) => event.type === "done")).toMatchObject({
        reason: done_reason,
        message: {
          stopReason: done_reason,
          content: [
            { type: "thinking", thinking: "Late reasoning" },
            { type: "text", text: "Visible answer" },
          ],
        },
      });
      const done = events.find((event) => event.type === "done") as {
        message?: { content?: Array<{ type: string; textSignature?: string }> };
      };
      expect(
        done.message?.content?.find((block) => block.type === "text")?.textSignature,
      ).toBeUndefined();
    },
  );

  it("preserves a native length stop when the partial response contains tool calls", async () => {
    const events = await streamOllamaEvents(
      [
        makeOllamaResponse({
          done_reason: "length",
          tool_calls: [{ function: { name: "read", arguments: { path: "README.md" } } }],
        }),
      ],
      {},
      {
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      } as never,
    );

    const done = events.find((event) => event.type === "done") as {
      reason?: string;
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
    };
    expect(done.reason).toBe("length");
    expect(done.message?.stopReason).toBe("length");
    expect(done.message?.content).toEqual([]);
  });

  it("promotes standalone bracketed local-model tool text to a structured tool call", async () => {
    const rawToolText = [
      "[mempalace_mempalace_search]",
      '{"query":"codename","wing":"personal","room":"identities"}',
      "[END_TOOL_REQUEST]",
    ].join("\n");

    const events = await streamOllamaEvents(
      [
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: rawToolText },
          done: false,
        },
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 5,
        },
      ],
      {},
      {
        messages: [{ role: "user", content: "test" }],
        tools: [
          {
            name: "mempalace_mempalace_search",
            description: "Search MemPalace",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done.reason).toBe("toolUse");
    expect(done.message?.stopReason).toBe("toolUse");
    expect(done.message?.content?.[0]).toMatchObject({
      type: "toolCall",
      name: "mempalace_mempalace_search",
      arguments: { query: "codename", wing: "personal", room: "identities" },
    });
  });

  it("redacts reflected credentials from a real non-2xx Ollama response", async () => {
    const configuredSecret = "stream-transport-configured-secret";
    const bearerCredential = "stream-transport-bearer-secret";
    let returnSuccess = false;
    let receivedConfiguredHeader: string | undefined;
    let receivedAuthorization: string | undefined;
    const server = createServer((request, response) => {
      const configuredHeader = request.headers["x-proxy-auth"];
      receivedConfiguredHeader =
        typeof configuredHeader === "string" ? configuredHeader : undefined;
      receivedAuthorization = request.headers.authorization;
      if (returnSuccess) {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(`${JSON.stringify(makeOllamaResponse({ content: "success control" }))}\n`);
        return;
      }
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: "rate limit exceeded",
          configuredEcho: configuredSecret,
          bearerEcho: bearerCredential,
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { fetchWithSsrFGuard } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/ssrf-runtime")
      >("openclaw/plugin-sdk/ssrf-runtime");
      fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

      const address = server.address() as AddressInfo;
      const streamFn = createOllamaStreamFn(`http://127.0.0.1:${address.port}`, {
        "X-Proxy-Auth": configuredSecret,
      });
      const stream = streamFn(
        STREAM_MODEL as never,
        { messages: [{ role: "user", content: "test" }] } as never,
        { apiKey: bearerCredential },
      );

      const events: Array<{ type: string; error?: { errorMessage?: string } }> = [];
      for await (const event of stream as AsyncIterable<{
        type: string;
        error?: { errorMessage?: string };
      }>) {
        events.push(event);
      }

      const errorEvent = events.find((event) => event.type === "error");
      expect(receivedConfiguredHeader).toBe(configuredSecret);
      expect(receivedAuthorization).toBe(`Bearer ${bearerCredential}`);
      expect(errorEvent?.error?.errorMessage).toMatch(/^429\b/);
      expect(errorEvent?.error?.errorMessage).toContain("rate limit exceeded");
      expect(errorEvent?.error?.errorMessage).not.toContain(configuredSecret);
      expect(errorEvent?.error?.errorMessage).not.toContain(bearerCredential);

      returnSuccess = true;
      const successEvents: Array<{ type: string }> = [];
      for await (const event of streamFn(
        STREAM_MODEL as never,
        { messages: [{ role: "user", content: "test" }] } as never,
        { apiKey: bearerCredential },
      ) as AsyncIterable<{ type: string }>) {
        successEvents.push(event);
      }
      expect(successEvents.some((event) => event.type === "done")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects incomplete UTF-8 after a real terminal Ollama response", async () => {
    let corrupted = true;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      const valid = Buffer.from(`${JSON.stringify(makeOllamaResponse({ content: "ok" }))}\n`);
      response.end(corrupted ? Buffer.concat([valid, Buffer.from([0xc3])]) : valid);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { fetchWithSsrFGuard } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/ssrf-runtime")
      >("openclaw/plugin-sdk/ssrf-runtime");
      fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

      const address = server.address() as AddressInfo;
      const streamFn = createOllamaStreamFn(`http://127.0.0.1:${address.port}`);
      const readEventTypes = async () => {
        const events: string[] = [];
        for await (const event of streamFn(
          STREAM_MODEL as never,
          { messages: [{ role: "user", content: "test" }] } as never,
          {},
        ) as AsyncIterable<{ type: string }>) {
          events.push(event.type);
        }
        return events;
      };

      expect(await readEventTypes()).toContain("error");
      corrupted = false;
      expect(await readEventTypes()).toContain("done");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps a real slow native Ollama response alive while NDJSON chunks advance", async () => {
    const chunkCount = 24;
    const chunkDelayMs = 250;
    const requestTimeoutMs = 5_000;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });

      let chunkIndex = 0;
      let nextChunk: ReturnType<typeof setTimeout> | undefined;
      const sendChunk = () => {
        if (chunkIndex === chunkCount) {
          response.end(`${JSON.stringify(makeOllamaResponse({ content: "" }))}\n`);
          return;
        }
        response.write(
          `${JSON.stringify({
            model: "qwen3.5",
            created_at: "2026-01-01T00:00:00Z",
            message: { role: "assistant", content: String(chunkIndex) },
            done: false,
          })}\n`,
        );
        chunkIndex += 1;
        nextChunk = setTimeout(sendChunk, chunkDelayMs);
      };

      response.once("close", () => {
        if (nextChunk) {
          clearTimeout(nextChunk);
        }
      });
      sendChunk();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { fetchWithSsrFGuard } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/ssrf-runtime")
      >("openclaw/plugin-sdk/ssrf-runtime");
      fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

      const address = server.address() as AddressInfo;
      const streamFn = createOllamaStreamFn(`http://127.0.0.1:${address.port}`);
      const stream = streamFn(
        STREAM_MODEL as never,
        { messages: [{ role: "user", content: "test" }] } as never,
        { requestTimeoutMs } as never,
      );

      const events: Array<{ type: string }> = [];
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        events.push(event);
      }

      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.some((event) => event.type === "done")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 20_000);

  it("still times out a real native Ollama stream that stops making progress", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(
        `${JSON.stringify({
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: "partial" },
          done: false,
        })}\n`,
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { fetchWithSsrFGuard } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/ssrf-runtime")
      >("openclaw/plugin-sdk/ssrf-runtime");
      fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

      const address = server.address() as AddressInfo;
      const streamFn = createOllamaStreamFn(`http://127.0.0.1:${address.port}`);
      const stream = streamFn(
        STREAM_MODEL as never,
        { messages: [{ role: "user", content: "test" }] } as never,
        { requestTimeoutMs: 120 } as never,
      );

      const events: Array<{ type: string }> = [];
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        events.push(event);
      }

      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(events.some((event) => event.type === "done")).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reports caller aborts during dense native stream processing as aborted", async () => {
    const chunks = [
      ...Array.from({ length: 65 }, (_value, index) => ({
        model: "qwen3.5",
        created_at: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
        message: { role: "assistant" as const, content: "x" },
        done: false,
      })),
      makeOllamaResponse({ content: "" }),
    ];
    const body = makeNdjsonBody(chunks);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const controller = new AbortController();
    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      STREAM_MODEL as never,
      { messages: [{ role: "user", content: "test" }] } as never,
      { signal: controller.signal },
    );

    setTimeout(() => {
      controller.abort();
    }, 0);

    const events: Array<{ type: string; reason?: string; error?: { stopReason?: string } }> = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      reason?: string;
      error?: { stopReason?: string };
    }>) {
      events.push(event);
    }

    const lastEvent = events.at(-1);
    expect(lastEvent).toMatchObject({
      type: "error",
      reason: "aborted",
      error: { stopReason: "aborted" },
    });
  });

  it("uses CJK-aware fallback usage while preserving missing cache provenance", async () => {
    const events = await streamOllamaEvents(
      [
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: "你好世界测试" },
          done: false,
        },
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
        },
      ],
      {},
      { messages: [{ role: "user", content: "这是一个测试用的句子呢" }] } as never,
    );

    const done = events.find((event) => event.type === "done") as {
      message?: {
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          cacheTelemetry?: { state: string };
        };
      };
    };
    expect(done?.message?.usage).toMatchObject({
      input: 12,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      cacheTelemetry: { state: "unavailable" },
    });
  });
});
