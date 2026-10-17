// Openai tests cover speech provider plugin behavior.
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const OPENAI_TTS_SNAPSHOT = "gpt-4o-mini-tts-2025-12-15";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async ({
    url,
    init,
  }: {
    url: string;
    init?: RequestInit;
  }): Promise<{ response: Response; release: () => Promise<void> }> => ({
    response: await globalThis.fetch(url, init),
    release: vi.fn(async () => {}),
  }),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected string request body");
  }
  const body: unknown = JSON.parse(init.body);
  if (!isRecord(body)) {
    throw new Error("expected OpenAI speech request body");
  }
  return body;
}

function mockSpeechFetchExpectingFormat(responseFormat: string) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = parseRequestBody(init);
    expect(body.response_format).toBe(responseFormat);
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function parseDirective(
  key: string,
  value: string,
  providerConfig: Record<string, unknown> = { baseUrl: "https://api.openai.com/v1/" },
  allowVoiceSettings?: boolean,
) {
  return buildOpenAISpeechProvider().parseDirectiveToken?.({
    key,
    value,
    policy: {
      allowVoice: true,
      allowModelId: true,
      ...(allowVoiceSettings === undefined ? {} : { allowVoiceSettings }),
    },
    providerConfig,
  } as never);
}

function speechRequest(overrides: Partial<SpeechSynthesisRequest> = {}): SpeechSynthesisRequest {
  return {
    text: "hello",
    cfg: {},
    providerConfig: { apiKey: "sk-test", model: "gpt-4o-mini-tts", voice: "alloy" },
    target: "audio-file",
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe("buildOpenAISpeechProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("advertises official speech snapshots without changing the default model", () => {
    const provider = buildOpenAISpeechProvider();

    expect(provider.defaultModel).toBe("gpt-4o-mini-tts");
    expect(provider.models).toContain(OPENAI_TTS_SNAPSHOT);
  });

  it("normalizes provider-owned speech config from raw provider config", () => {
    const provider = buildOpenAISpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          openai: {
            apiKey: "sk-test",
            baseUrl: "https://example.com/v1/",
            model: "tts-1",
            voice: "alloy",
            speed: 1.25,
            instructions: " Speak warmly ",
            responseFormat: " WAV ",
            extraBody: {
              lang: "en-US",
            },
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "tts-1",
      voice: "alloy",
      speed: 1.25,
      instructions: "Speak warmly",
      responseFormat: "wav",
      extraBody: {
        lang: "en-US",
      },
    });
  });

  it("drops malformed speech speed values", () => {
    const provider = buildOpenAISpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: { providers: { openai: { speed: 4.5 } } },
    });

    expect(resolved?.speed).toBeUndefined();
  });

  it("passes custom endpoint speech speeds through", () => {
    const provider = buildOpenAISpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          openai: {
            baseUrl: "https://tts.example.com/v1",
            speed: 4.5,
          },
        },
      },
    });

    expect(resolved?.speed).toBe(4.5);
  });

  it("uses talk base url overrides when validating speech speed", () => {
    const provider = buildOpenAISpeechProvider();

    const resolvedConfig = provider.resolveTalkConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      baseTtsConfig: { providers: { openai: { apiKey: "sk-base" } } },
      talkProviderConfig: {
        baseUrl: "https://tts.example.com/v1",
        speed: 4.5,
      },
    });

    expect(resolvedConfig).toMatchObject({ baseUrl: "https://tts.example.com/v1", speed: 4.5 });
  });

  it("parses OpenAI directive tokens against the resolved base url", () => {
    expect(parseDirective("voice", "alloy")).toEqual({
      handled: true,
      overrides: { voice: "alloy" },
    });

    expect(parseDirective("openai_model", OPENAI_TTS_SNAPSHOT)).toEqual({
      handled: true,
      overrides: { model: OPENAI_TTS_SNAPSHOT },
    });

    expect(parseDirective("model", "kokoro-custom-model")).toEqual({ handled: false });
  });

  it("sends dated speech snapshots through a real loopback HTTP request", async () => {
    const provider = buildOpenAISpeechProvider();
    let receivedRequest:
      | {
          method: string | undefined;
          url: string | undefined;
          body: unknown;
        }
      | undefined;
    await withServer(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          receivedRequest = {
            method: request.method,
            url: request.url,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          };
          response.writeHead(200, { "content-type": "audio/mpeg" });
          response.end(Buffer.from("snapshot-audio"));
        });
      },
      async (baseUrl) => {
        const result = await provider.synthesize(
          speechRequest({
            text: "snapshot request",
            providerConfig: {
              apiKey: "sk-test",
              baseUrl: `${baseUrl}/v1`,
              model: OPENAI_TTS_SNAPSHOT,
              voice: "alloy",
              instructions: " Speak warmly ",
            },
          }),
        );

        expect(receivedRequest).toEqual({
          method: "POST",
          url: "/v1/audio/speech",
          body: {
            model: OPENAI_TTS_SNAPSHOT,
            input: "snapshot request",
            voice: "alloy",
            response_format: "mp3",
            instructions: "Speak warmly",
          },
        });
        expect(result.audioBuffer).toEqual(Buffer.from("snapshot-audio"));
      },
    );
  });

  it("parses preferred-OpenAI speed directive within the supported range", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.parseDirectiveToken?.(createSpeedDirectiveContext("speed", "1.5") as never),
    ).toEqual({
      handled: true,
      overrides: { speed: 1.5 },
    });
  });

  it("parses explicit openai_speed alias", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.parseDirectiveToken?.(createSpeedDirectiveContext("openai_speed", "0.75") as never),
    ).toEqual({
      handled: true,
      overrides: { speed: 0.75 },
    });
  });

  it("ignores OpenAI speed directives when allowVoiceSettings is disabled", () => {
    expect(parseDirective("speed", "1.5", undefined, false)).toEqual({ handled: true });
  });

  it("warns on partial OpenAI speed values", () => {
    expect(parseDirective("speed", "1.5abc", undefined, true)).toEqual({
      handled: true,
      warnings: ['invalid OpenAI speed "1.5abc" (0.25-4.0)'],
    });
  });

  it("warns on OpenAI speed values outside the supported 0.25..4 range", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.parseDirectiveToken?.(createSpeedDirectiveContext("speed", "5") as never),
    ).toEqual({
      handled: true,
      warnings: ['invalid OpenAI speed "5" (0.25-4.0)'],
    });
  });

  it("passes custom endpoint OpenAI-compatible speed directives through", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.parseDirectiveToken?.(
        createSpeedDirectiveContext("speed", "4.5", "https://tts.example.com/v1") as never,
      ),
    ).toEqual({
      handled: true,
      overrides: { speed: 4.5 },
    });
  });

  it("uses OPENAI_TTS_BASE_URL when parsing OpenAI-compatible speed directives", () => {
    vi.stubEnv("OPENAI_TTS_BASE_URL", "https://tts.example.com/v1");
    expect(parseDirective("speed", "4.5", {}, true)).toEqual({
      handled: true,
      overrides: { speed: 4.5 },
    });
  });

  it("treats a blank environment API key as missing across speech entry points", async () => {
    vi.stubEnv("OPENAI_API_KEY", "   ");
    const provider = buildOpenAISpeechProvider();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const providerConfig = {
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    };

    expect(await provider.isConfiguredAsync?.({ providerConfig, timeoutMs: 30_000 })).toBe(false);
    await expect(provider.synthesize(speechRequest({ providerConfig }))).rejects.toThrow(
      "OpenAI API key missing",
    );
    await expect(provider.synthesizeTelephony?.(speechRequest({ providerConfig }))).rejects.toThrow(
      "OpenAI API key missing",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims a valid environment API key for normal and telephony synthesis", async () => {
    vi.stubEnv("OPENAI_API_KEY", "  sk-env  ");
    const provider = buildOpenAISpeechProvider();
    const authorizationHeaders: Array<string | null> = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const providerConfig = {
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    };

    expect(await provider.isConfiguredAsync?.({ providerConfig, timeoutMs: 30_000 })).toBe(true);
    await provider.synthesize(speechRequest({ providerConfig }));
    await provider.synthesizeTelephony?.(speechRequest({ providerConfig }));

    expect(authorizationHeaders).toEqual(["Bearer sk-env", "Bearer sk-env"]);
  });

  it("preserves talk responseFormat overrides", () => {
    const provider = buildOpenAISpeechProvider();

    const resolvedConfig = provider.resolveTalkConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      baseTtsConfig: { providers: { openai: { apiKey: "sk-base", responseFormat: "mp3" } } },
      talkProviderConfig: {
        apiKey: "sk-talk",
        responseFormat: " WAV ",
      },
    });
    expect(resolvedConfig).toMatchObject({ apiKey: "sk-talk", responseFormat: "wav" });
  });

  it("maps Talk speak params onto OpenAI speech overrides", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: {},
        params: {
          text: "Hello from talk mode.",
          voiceId: "nova",
          modelId: "tts-1",
          speed: 218 / 175,
        },
      }),
    ).toEqual({
      voice: "nova",
      model: "tts-1",
      speed: 218 / 175,
    });
  });

  it("uses wav for Groq-compatible OpenAI TTS endpoints", async () => {
    const provider = buildOpenAISpeechProvider();
    mockSpeechFetchExpectingFormat("wav");

    const result = await provider.synthesize(
      speechRequest({
        providerConfig: {
          apiKey: "sk-test",
          baseUrl: "https://api.groq.com/openai/v1",
          model: "canopylabs/orpheus-v1-english",
          voice: "daniel",
        },
      }),
    );

    expect(result).toMatchObject({
      outputFormat: "wav",
      fileExtension: ".wav",
      voiceCompatible: false,
    });
  });

  it("applies the configured media byte cap to synthesized audio", async () => {
    const provider = buildOpenAISpeechProvider();
    globalThis.fetch = vi.fn(
      async () => new Response(new Uint8Array(2048), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      provider.synthesize(speechRequest({ cfg: { agents: { defaults: { mediaMaxMb: 0.001 } } } })),
    ).rejects.toThrow("OpenAI TTS audio response exceeds");
  });

  it("applies provider overrides to telephony synthesis", async () => {
    const provider = buildOpenAISpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body).toMatchObject({
        model: "tts-1",
        voice: "nova",
        speed: 1.25,
        response_format: "pcm",
      });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesizeTelephony?.(
      speechRequest({
        providerConfig: {
          apiKey: "sk-test",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          speed: 1,
        },
        providerOverrides: { model: "tts-1", voice: "nova", speed: 1.25 },
      }),
    );

    expect(result?.outputFormat).toBe("pcm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { responseFormat: "wav" as const, voiceCompatible: false },
    { responseFormat: "mp3" as const, voiceCompatible: true },
  ])(
    "marks configured $responseFormat voice-note compatibility as $voiceCompatible",
    async ({ responseFormat, voiceCompatible }) => {
      const provider = buildOpenAISpeechProvider();
      mockSpeechFetchExpectingFormat(responseFormat);

      const result = await provider.synthesize(
        speechRequest({
          providerConfig: {
            apiKey: "sk-test",
            model: "gpt-4o-mini-tts",
            voice: "alloy",
            responseFormat,
          },
          target: "voice-note",
        }),
      );

      expect(result).toMatchObject({
        outputFormat: responseFormat,
        fileExtension: `.${responseFormat}`,
        voiceCompatible,
      });
    },
  );

  it("passes extra_body config through to OpenAI-compatible speech requests", async () => {
    const provider = buildOpenAISpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseRequestBody(init);
      expect(body).toMatchObject({
        model: "custom-tts",
        voice: "custom-voice",
        lang: "en-US",
        response_format: "mp3",
      });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesize(
      speechRequest({
        providerConfig: {
          apiKey: "sk-test",
          baseUrl: "https://proxy.example.com/openai/v1",
          model: "custom-tts",
          voice: "custom-voice",
          responseFormat: "mp3",
          extra_body: { lang: "en-US" },
        },
      }),
    );

    expect(result.outputFormat).toBe("mp3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
