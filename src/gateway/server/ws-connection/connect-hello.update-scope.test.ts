import { EventEmitter, once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { HelloOk } from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveGatewayAuth } from "../../auth-resolve.js";
import { startGatewayTailscaleExposure } from "../../server-tailscale.js";
import { prepareTailscalePublishedOrigin } from "../../tailscale-published-origin.js";
import type { GatewayWsClient } from "../ws-types.js";

const tailOrigin = "https://gateway.tailnet.ts.net";
const teamOrigin = "https://team.example.test";

const mocks = vi.hoisted(() => ({
  securityEvent: vi.fn(),
  tabs: vi.fn((_scopes: readonly string[]) => []),
  widgets: vi.fn((_scopes: readonly string[]) => []),
  snapshot: vi.fn((opts?: { includeUpdateDetails?: boolean }) => {
    const updateAvailable = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
    };
    return {
      presence: [],
      stateVersion: { presence: 1, health: 1 },
      updateAvailable: opts?.includeUpdateDetails
        ? {
            ...updateAvailable,
            currentSha: "1111111111111111111111111111111111111111",
            upstreamRef: "origin/main",
            upstreamSha: "2222222222222222222222222222222222222222",
            commitsBehind: 1,
            commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
          }
        : updateAvailable,
      ...(opts?.includeUpdateDetails
        ? {
            updateSchedule: { channel: "dev", autoEnabled: true, install: { kind: "git" } },
          }
        : {}),
    };
  }),
}));

// mock-isolation: Supply deterministic update facts without starting health services.
vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: mocks.snapshot,
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
}));

vi.mock("../../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: vi.fn(() => false),
}));

// mock-isolation: Control plugin UI descriptors independently of the active registry.
vi.mock("../../control-ui-plugin-tabs.js", () => ({
  listControlUiLinkReaders: vi.fn(() => []),
  listControlUiPluginTabs: mocks.tabs,
  listControlUiPluginWidgetKinds: mocks.widgets,
}));

// mock-isolation: Observe security events without publishing them outside the fixture.
vi.mock("./connect-auth-security.js", () => ({
  emitGatewayAuthSecurityEvent: mocks.securityEvent,
}));

vi.mock("../../../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../version.js")>()),
  resolveRuntimeServiceBuildId: () => "build-a",
}));

const tailscaleClaim = vi.hoisted(() => vi.fn());
vi.mock("../../../infra/tailscale.js", () => ({
  claimTailscaleRoute: tailscaleClaim,
  getTailnetHostnameAfterServe: async () => "gateway.tailnet.ts.net",
  getTailnetHostname: async () => null,
}));

import { sendGatewayHello } from "./connect-hello.js";

function makeContext(
  role: "operator" | "node" = "operator",
  scopes: string[] = ["operator.read"],
  client?: Pick<GatewayWsClient, "internal" | "preparedSessionProfile">,
) {
  return {
    handler: {
      socket: new EventEmitter(),
      isClosed: vi.fn(() => false),
      getClient: () => client ?? null,
      connId: `conn-${role}`,
      bootId: "gateway-boot-a",
      gatewayMethods: [],
      events: [],
      buildRequestContext: () => ({ nodeRegistry: { get: () => undefined } }),
      refreshHealthSnapshot: vi.fn(async () => ({})),
      close: vi.fn(),
      advanceHandshakePhase: vi.fn(),
      setCloseCause: vi.fn(),
      logGateway: { warn: vi.fn() },
      logHealth: { error: vi.fn() },
    },
    frame: { id: `hello-${role}` },
    connectParams: {
      client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
      role,
      scopes,
    },
    configSnapshot: {},
    sendFrame: vi.fn(async (_frame: unknown) => undefined),
    onHelloDelivered: vi.fn(),
    pendingNodePairingCleanup: {},
    releasePendingNodePairingCleanup: vi.fn(async () => undefined),
  };
}

function helloPayload(context: ReturnType<typeof makeContext>) {
  const response = context.sendFrame.mock.calls.at(0)?.at(0) as { payload?: HelloOk } | undefined;
  return response?.payload;
}

function expectRedactedHelloSnapshot(context: ReturnType<typeof makeContext>) {
  const access = { client: null, includeSensitive: false, includeUpdateDetails: false };
  expect(mocks.snapshot).toHaveBeenCalledWith(access);
  expect(helloPayload(context)?.snapshot.updateAvailable).toEqual({
    currentVersion: "2026.8.7",
    latestVersion: "2026.8.8",
    channel: "dev",
  });
  expect(helloPayload(context)?.snapshot.updateSchedule).toBeUndefined();
}

function publishRoute(origin = tailOrigin, mode: "serve" | "funnel" = "serve") {
  return prepareTailscalePublishedOrigin({ origin, mode });
}

const tailscaleState = { resolvedAuth: { mode: "token", allowTailscale: true } };

function deviceToken(token: string, scopes = ["operator.read"]) {
  return { token, role: "operator", scopes, createdAtMs: 1 };
}

async function sendHello(
  context: ReturnType<typeof makeContext>,
  state: Partial<Parameters<typeof sendGatewayHello>[1]> = {},
  principal?: string,
) {
  await sendGatewayHello(
    context as never,
    {
      resolvedAuth: { mode: "none" },
      authResult: { ok: true, method: "none" },
      authMethod: "none",
      bootstrapDeviceTokens: [],
      role: context.connectParams.role,
      scopes: context.connectParams.scopes,
      ...state,
    } as never,
    {},
    principal,
  );
}

describe("sendGatewayHello update detail scope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    prepareTailscalePublishedOrigin({ origin: "https://reset.test", mode: "serve" })();
  });

  beforeEach(() => vi.clearAllMocks());

  it.each(["write", "suggest", "view", "none", undefined] as const)(
    "projects optional session cap %s",
    async (sessionCap) => {
      const context = makeContext("operator", ["operator.write"], {
        internal: { operatorRoleActor: { kind: "operator", profileId: "profile-riley" } },
        preparedSessionProfile: {
          profileId: "profile-riley",
          aliases: new Set(["profile-riley"]),
          role: "collaborator",
        },
      });
      if (sessionCap !== undefined) {
        const collaborator = {
          sessions: { others: sessionCap },
          agents: ["main"],
          scopes: ["operator.write"],
        };
        context.configSnapshot = {
          gateway: {
            roles: {
              default: "collaborator",
              definitions: { collaborator },
            },
          },
        } satisfies OpenClawConfig;
      }

      await sendHello(context);

      const auth = helloPayload(context)?.auth;
      if (sessionCap === undefined) {
        expect(auth).not.toHaveProperty("sessionCap");
      } else {
        expect(auth?.sessionCap).toBe(sessionCap);
      }
    },
  );

  it.each([
    { mode: "trusted-proxy", tailscale: "off", expected: true },
    { mode: "trusted-proxy", tailscale: "serve", allowTailscale: true, expected: true },
    { mode: "token", tailscale: "serve", expected: true },
    { mode: "token", tailscale: "serve", publicOrigin: undefined, expected: true },
    { mode: "password", tailscale: "serve", allowTailscale: true, expected: true },
    { mode: "password", tailscale: "serve", expected: false },
    { mode: "token", tailscale: "serve", allowTailscale: false, expected: false },
    { mode: "token", tailscale: "off", expected: false },
    { mode: "password", tailscale: "funnel", allowTailscale: true, expected: false },
    { mode: "none", tailscale: "off", expected: false },
    { mode: "none", tailscale: "serve", expected: false },
    { mode: "trusted-proxy", tailscale: "serve", expected: false, role: "node" },
    { mode: "trusted-proxy", tailscale: "serve", expected: false, publicOrigin: undefined },
    {
      mode: "trusted-proxy",
      tailscale: "serve",
      expected: false,
      publicOrigin: "http://127.0.0.1:18789",
    },
    { mode: "trusted-proxy", tailscale: "serve", expected: false, enabled: false },
  ] as const)(
    "advertises dashboard: $mode / $tailscale / $expected",
    async ({ mode, tailscale, expected, ...options }) => {
      if (tailscale !== "off") {
        publishRoute(undefined, tailscale);
      }
      const config: OpenClawConfig = {
        gateway: {
          publicOrigin: "publicOrigin" in options ? options.publicOrigin : teamOrigin,
          auth: {
            mode,
            ...("allowTailscale" in options ? { allowTailscale: options.allowTailscale } : {}),
          },
          tailscale: { mode: tailscale },
          controlUi: {
            basePath: " /team/ ",
            ...("enabled" in options ? { enabled: options.enabled } : {}),
          },
        },
      };
      const role = "role" in options ? options.role : "operator";
      const context = makeContext(role);
      context.configSnapshot = config;
      const state = {
        resolvedAuth: resolveGatewayAuth({
          authConfig: config.gateway?.auth,
          tailscaleMode: tailscale,
          env: {},
        }),
      };
      await sendHello(context, state as never);
      expect(helloPayload(context)?.snapshot.controlUiIdentityUrl).toBe(
        expected
          ? mode === "trusted-proxy"
            ? `${teamOrigin}/team/`
            : `${tailOrigin}/team/`
          : undefined,
      );
      if (!expected && ("role" in options || "publicOrigin" in options || "enabled" in options)) {
        expect(helloPayload(context)?.snapshot).not.toHaveProperty("controlUiIdentityUrl");
      }
      prepareTailscalePublishedOrigin({ origin: "https://reset.test", mode: "serve" })();
      if (expected && mode !== "trusted-proxy") {
        expect(context.handler.close).toHaveBeenCalledWith(1012, expect.any(String));
      } else {
        expect(context.handler.close).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["before", "after", "during"] as const)(
    "releases live announcement owners: %s delivery",
    async (phase) => {
      const clear = publishRoute();
      const context = makeContext();
      if (phase === "before") {
        context.handler.isClosed.mockReturnValue(true);
        context.handler.socket.emit("close");
      }
      if (phase === "during") {
        context.sendFrame.mockImplementation(async () => {
          clear();
        });
      }
      await sendHello(context, tailscaleState as never);
      if (phase !== "during") {
        if (phase === "after") {
          context.handler.socket.emit("close");
        }
        clear();
        expect(context.handler.close).not.toHaveBeenCalled();
      } else {
        expect(context.handler.close).toHaveBeenCalledWith(1012, expect.any(String));
      }
    },
  );

  it.each(["exit", "cleanup", "replacement"] as const)(
    "renews hello after route %s",
    async (withdrawal) => {
      const gatewayMethods = ["health", "config.get"];
      const exited = createDeferredCore();
      tailscaleClaim.mockResolvedValue({
        exited: exited.promise,
        isActive: () => true,
        stop: vi.fn(),
      });
      const cleanup = await startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        backend: { host: "127.0.0.1", port: 19000 },
        logTailscale: { info: vi.fn(), warn: vi.fn() },
      });
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing WebSocket listener");
      }
      const clients: WebSocket[] = [];
      const connect = async () => {
        const accepted = once(server, "connection");
        const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
        clients.push(client);
        await once(client, "open");
        const [socket] = (await accepted) as [WebSocket];
        const context = makeContext();
        const response = once(client, "message");
        Object.assign(context.handler, {
          gatewayMethods,
          socket,
          close: (code?: number, reason?: string) => socket.close(code, reason),
        });
        context.sendFrame.mockImplementation(async (frame) => {
          await new Promise<void>((resolve, reject) => {
            socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve()));
          });
        });
        await sendHello(context, tailscaleState as never);
        const [frame] = await response;
        const hello = JSON.parse(String(frame)) as { payload: HelloOk };
        return { client, hello: hello.payload, close: vi.fn() };
      };
      try {
        const original = await connect();
        expect(original.hello.features.methods).toEqual(gatewayMethods);
        expect(original.hello.snapshot.controlUiIdentityUrl).toBe(`${tailOrigin}/`);
        original.client.on("close", original.close);
        if (withdrawal === "exit") {
          exited.resolve();
        } else if (withdrawal === "cleanup") {
          await cleanup?.();
        } else {
          publishRoute("https://replacement.tailnet.ts.net");
          // A late old cleanup must not withdraw the replacement's announcement.
          await cleanup?.();
        }
        await vi.waitFor(() =>
          expect(original.close).toHaveBeenCalledWith(1012, expect.anything()),
        );
        const renewed = await connect();
        expect(renewed.hello.features.methods).toEqual(gatewayMethods);
        expect(renewed.hello.snapshot.controlUiIdentityUrl).toBe(
          withdrawal === "replacement" ? "https://replacement.tailnet.ts.net/" : undefined,
        );
        expect(renewed.client.readyState).toBe(WebSocket.OPEN);
      } finally {
        for (const socket of [...clients, ...server.clients]) {
          socket.terminate();
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        await cleanup?.();
      }
    },
  );

  it.each([
    { label: "pairing-only operator", role: "operator" as const, scopes: ["operator.pairing"] },
    { label: "node", role: "node" as const, scopes: ["operator.read"] },
  ])("omits update details for a $label", async ({ role, scopes }) => {
    const context = makeContext(role, scopes);
    await sendHello(context);
    expectRedactedHelloSnapshot(context);
    expect(helloPayload(context)?.features.capabilities).toContain("node-permission-errors");
    expect(helloPayload(context)?.features.capabilities).toContain("agent-session-id-create-v1");
  });

  const remote = { publicOrigin: teamOrigin };
  it.each([
    [{}, "bundled", true, undefined],
    [{ controlUi: { enabled: true } }, "bundled", true, undefined],
    [{ controlUi: { enabled: false } }, "bundled", false, undefined],
    [{ controlUi: { root: "/custom/ui" } }, "configured", false, undefined],
    [
      { ...remote, controlUi: { basePath: " /remote/// " } },
      "bundled",
      true,
      `${teamOrigin}/remote`,
    ],
    [{ ...remote, controlUi: { enabled: false } }, "bundled", false, undefined],
  ] as const)(
    "projects UI metadata for %j",
    async (gateway, source, browserFocus, controlUiUrl) => {
      const context = makeContext();
      context.configSnapshot = { gateway };
      await sendHello(context);
      const hello = helloPayload(context);
      expect(hello?.server).toMatchObject({ buildId: "build-a", controlUiBuildSource: source });
      expect(hello?.features.capabilities?.includes("control-ui-browser-focus")).toBe(browserFocus);
      expect(hello?.controlUiUrl).toBe(controlUiUrl);
      if (controlUiUrl === undefined) {
        expect(hello).not.toHaveProperty("controlUiUrl");
      }
    },
  );

  it("keeps hello projection and telemetry at effective scopes", async () => {
    const state = {
      deviceToken: deviceToken("paired-token", ["operator.read", "operator.admin"]),
    };

    const context = makeContext("operator", ["operator.pairing"]);
    await sendHello(context, state as never, "owner-profile");
    expectRedactedHelloSnapshot(context);
    expect(helloPayload(context)?.auth).toEqual({
      method: "none",
      role: "operator",
      scopes: ["operator.pairing"],
      recoveryMigrationAllowed: true,
      recoveryScope: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      deviceToken: "paired-token",
      issuedAtMs: 1,
    });
    expect(mocks.tabs).toHaveBeenCalledWith(["operator.pairing"], {
      requireGatewayAuthGrant: false,
    });
    expect(mocks.widgets).toHaveBeenCalledWith(["operator.pairing"]);
    expect(mocks.securityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ role: "operator", scopes: ["operator.pairing"] }),
    );
  });

  it("keeps recovery scope owned by the canonical authenticated principal", async () => {
    const sendFor = async (principal: string, token: string, generation: string) => {
      const context = makeContext();
      const state = {
        authResult: { ok: true, method: "trusted-proxy", user: `${principal}@example.test` },
        device: { id: "device-a" },
        deviceToken: deviceToken(token),
        sessionSharedGatewaySessionGeneration: generation,
      };
      await sendHello(context, state as never, principal);
      const auth = helloPayload(context)?.auth;
      expect(auth?.recoveryMigrationAllowed).toBeUndefined();
      return auth?.recoveryScope;
    };

    const alice = await sendFor("profile-alice", "device-token-a", "shared-generation-a");
    const rotated = await sendFor("profile-alice", "device-token-b", "shared-generation-b");
    const bob = await sendFor("profile-bob", "device-token-a", "shared-generation-a");

    expect(rotated).toBe(alice);
    expect(bob).not.toBe(alice);
    for (const scope of [alice, rotated, bob]) {
      expect(scope).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(scope).not.toContain("profile-");
      expect(scope).not.toContain("device-token-");
    }
  });
});
