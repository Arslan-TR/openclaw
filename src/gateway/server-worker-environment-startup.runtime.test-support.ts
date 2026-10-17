import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import { createGatewayWorkerEnvironmentRuntime } from "./server-worker-environment-startup.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";

type RuntimeParams = Parameters<typeof createGatewayWorkerEnvironmentRuntime>[0];

export function createWorkerStartupRuntime(
  startup: RuntimeParams["startup"],
  getPluginRegistry: RuntimeParams["getPluginRegistry"],
  overrides: Partial<Omit<RuntimeParams, "startup" | "getPluginRegistry">> = {},
) {
  return createGatewayWorkerEnvironmentRuntime({
    scheduler: createTestGatewayScheduler(),
    getPluginRegistry,
    getPortalRuntime: () => undefined,
    resolveGatewayContext: () => undefined,
    desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    startup,
    log: { child: () => ({ info: () => {}, warn: () => {} }) },
    ...overrides,
  });
}

export function workerStartupReceipt() {
  return {
    bundleHash: "a".repeat(64),
    openclawVersion: "2026.8.14",
    protocolFeatures: ["worker-heartbeat-v1"],
    installKind: "bundle" as const,
  };
}

export function workerStartupCredential(token: string, sessionId: string | null = null) {
  return {
    credentialHash: hashWorkerCredential(token),
    sessionId,
    rpcSetVersion: 1,
    expiresAtMs: Date.now() + 60_000,
  };
}
