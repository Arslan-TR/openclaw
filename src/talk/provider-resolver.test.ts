import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { InternalRealtimeVoiceProviderApi } from "./provider-internal.js";
import {
  resolveConfiguredRealtimeVoiceProvider as resolveProvider,
  resolveConfiguredRealtimeVoiceProviderAsync as resolveProviderAsync,
  resolveRealtimeVoiceProviderCapabilitiesAsync,
} from "./provider-resolver.js";

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

function attachInternalRealtimeVoiceProviderApi(
  provider: RealtimeVoiceProviderPlugin,
  api: InternalRealtimeVoiceProviderApi,
): void {
  Object.defineProperty(provider, INTERNAL_REALTIME_VOICE_PROVIDER, {
    configurable: true,
    value: api,
  });
}

function makeProvider(
  id: string,
  overrides: Partial<RealtimeVoiceProviderPlugin> = {},
): RealtimeVoiceProviderPlugin {
  return {
    id,
    label: id,
    isConfigured: () => false,
    createBridge: () => {
      throw new Error("unused");
    },
    ...overrides,
  };
}

describe("realtime voice provider resolver", () => {
  const providers: RealtimeVoiceProviderPlugin[] = [
    makeProvider("first", { autoSelectOrder: 1 }),
    makeProvider("second", {
      autoSelectOrder: 2,
      resolveConfig: ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
      isConfigured: ({ providerConfig }) => providerConfig.enabled === true,
    }),
  ];

  it("awaits async provider hooks in priority order and applies session overrides", async () => {
    const legacyHook = vi.fn(() => {
      throw new Error("synchronous credential lookup must not run");
    });
    const attempted: string[] = [];
    const asyncProviders: RealtimeVoiceProviderPlugin[] = providers.map((provider) => ({
      ...provider,
      resolveConfig: legacyHook,
      isConfigured: legacyHook,
      resolveConfigAsync: async ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
      isConfiguredAsync: async ({ providerConfig }) => {
        attempted.push(provider.id);
        return providerConfig.enabled === true;
      },
    }));

    const resolution = await resolveProviderAsync({
      cfg: {},
      providers: asyncProviders.toReversed(),
      defaultModel: "default-model",
      providerConfigs: { second: { enabled: true, model: "configured-model" } },
      providerConfigOverrides: { model: "session-model" },
    });

    expect(attempted).toEqual(["first", "second"]);
    expect(resolution.provider.id).toBe("second");
    expect(resolution.providerConfig).toEqual({
      enabled: true,
      model: "session-model",
      resolved: true,
    });
    expect(legacyHook).not.toHaveBeenCalled();
  });

  it("prefers async browser readiness and capabilities over retained synchronous hooks", async () => {
    const legacyHook = vi.fn(() => {
      throw new Error("synchronous browser credential lookup must not run");
    });
    const provider: RealtimeVoiceProviderPlugin = {
      ...providers[0]!,
      isConfigured: legacyHook,
    };
    attachInternalRealtimeVoiceProviderApi(provider, {
      isBrowserSessionConfigured: legacyHook,
      resolveBrowserSessionCapabilities: legacyHook,
      isBrowserSessionConfiguredAsync: async ({ agentId }) => agentId === "voice-agent",
      resolveBrowserSessionCapabilitiesAsync: async ({ agentId }) => ({
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsGatewayControl: agentId === "voice-agent",
      }),
    });

    const resolution = await resolveProviderAsync({
      configuredProviderId: provider.id,
      providers: [provider],
      agentId: "voice-agent",
      surface: "browser-session",
    });

    expect(resolution.provider).toBe(provider);
    expect(resolution.capabilities?.supportsGatewayControl).toBe(true);
    expect(legacyHook).not.toHaveBeenCalled();
  });

  it("propagates async readiness rejection without synchronous fallback", async () => {
    const failure = new Error("credential owner unavailable");
    const legacyHook = vi.fn(() => true);
    const legacyResolveConfig = vi.fn(() => ({}));
    const provider: RealtimeVoiceProviderPlugin = {
      ...providers[0]!,
      resolveConfig: legacyResolveConfig,
      isConfigured: legacyHook,
      isConfiguredAsync: async () => {
        throw failure;
      },
    };

    await expect(
      resolveProviderAsync({
        configuredProviderId: provider.id,
        providers: [provider],
      }),
    ).rejects.toBe(failure);
    expect(legacyHook).not.toHaveBeenCalled();
  });

  it("preserves the typed availability error when every auto provider is unavailable", () => {
    class ProviderUnavailableError extends Error {}
    const unavailable = new ProviderUnavailableError("provider owner is unavailable");
    const assertProviderAvailable = vi.fn(() => {
      throw unavailable;
    });

    expect(() =>
      resolveProvider({
        cfg: {},
        providers,
        isProviderAvailable: () => false,
        assertProviderAvailable,
      }),
    ).toThrow(unavailable);
    expect(assertProviderAvailable).toHaveBeenCalledOnce();
    expect(assertProviderAvailable).toHaveBeenCalledWith(providers[0]);
  });

  it("passes the requested agent scope to explicitly selected provider checks", () => {
    const isConfigured = vi.fn(() => true);
    const provider = makeProvider("agent-scoped", {
      isConfigured,
    });

    resolveProvider({
      agentId: "voice-agent",
      cfg: {},
      configuredProviderId: provider.id,
      providers: [provider],
    });

    expect(isConfigured).toHaveBeenCalledWith({
      agentId: "voice-agent",
      cfg: {},
      providerConfig: {},
    });
  });

  it("keeps browser-only providers out of bridge auto-selection", () => {
    const isBrowserSessionConfigured = vi.fn(
      ({ agentId }: { agentId?: string }) => agentId === "voice-agent",
    );
    const browserOnly = makeProvider("browser-only", { autoSelectOrder: 1 });
    attachInternalRealtimeVoiceProviderApi(browserOnly, {
      isBrowserSessionConfigured,
    });
    const bridge = makeProvider("bridge", {
      autoSelectOrder: 2,
      isConfigured: () => true,
    });

    expect(
      resolveProvider({
        cfg: {},
        providers: [browserOnly, bridge],
      }).provider.id,
    ).toBe("bridge");
    expect(
      resolveProvider({
        cfg: {},
        agentId: "voice-agent",
        providers: [browserOnly, bridge],
        surface: "browser-session",
      }).provider.id,
    ).toBe("browser-only");
    expect(isBrowserSessionConfigured).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "voice-agent" }),
    );
  });

  it("limits internal relay readiness to the gateway-relay surface", () => {
    const relayOnly = makeProvider("relay-only");
    attachInternalRealtimeVoiceProviderApi(relayOnly, {
      isBrowserSessionConfigured: () => false,
      isGatewayRelayConfigured: () => true,
    });

    expect(() =>
      resolveProvider({
        configuredProviderId: "relay-only",
        providers: [relayOnly],
        surface: "bridge",
      }),
    ).toThrow('Realtime voice provider "relay-only" is not configured');
    expect(
      resolveProvider({
        configuredProviderId: "relay-only",
        providers: [relayOnly],
        surface: "gateway-relay",
      }).provider,
    ).toBe(relayOnly);
  });

  it("applies a default model before provider config resolution", () => {
    const resolution = resolveProvider({
      cfg: {},
      configuredProviderId: "second",
      defaultModel: "gpt-realtime",
      providers,
      providerConfigs: {
        second: { enabled: true },
      },
    });

    expect(resolution.providerConfig).toStrictEqual({
      enabled: true,
      model: "gpt-realtime",
      resolved: true,
    });
  });

  it("resolves config-specific provider capabilities", async () => {
    const provider = makeProvider("dynamic", {
      capabilities: {
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsVideoFrames: true,
      },
      isConfigured: () => true,
    });
    attachInternalRealtimeVoiceProviderApi(provider, {
      isBrowserSessionConfigured: () => true,
      isBrowserSessionConfiguredAsync: async () => true,
      resolveBrowserSessionCapabilitiesAsync: async ({ providerConfig, agentId, model }) => ({
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsVideoFrames: providerConfig.authMode !== "native" && model === "gpt-live-1",
        supportsGatewayControl: agentId === "molty",
      }),
    });

    const capabilities = (authMode: string, agentId?: string) =>
      resolveRealtimeVoiceProviderCapabilitiesAsync({
        provider,
        providerConfig: { authMode },
        agentId,
        model: "gpt-live-1",
        surface: "browser-session",
      });
    expect((await capabilities("native"))?.supportsVideoFrames).toBe(false);
    const scopedCapabilities = await capabilities("oauth", "molty");
    expect(scopedCapabilities).toMatchObject({
      supportsVideoFrames: true,
      supportsGatewayControl: true,
    });
    expect((await capabilities("oauth"))?.supportsGatewayControl).toBe(false);
  });
});
