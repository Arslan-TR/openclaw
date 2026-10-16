import "../../test-utils/prepare-compiled-subprocesses.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import type { HealthSummary } from "../health/types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

const {
  collectGatewayHealthSnapshotMock,
  getRuntimeConfigMock,
  getUpdateAvailableMock,
  getUpdateScheduleMock,
} = vi.hoisted(() => ({
  collectGatewayHealthSnapshotMock:
    vi.fn<typeof import("../health/collector.js").collectGatewayHealthSnapshot>(),
  getRuntimeConfigMock: vi.fn(),
  getUpdateAvailableMock: vi.fn(),
  getUpdateScheduleMock: vi.fn(),
}));

vi.mock("../health/collector.js", () => ({
  collectGatewayHealthSnapshot: collectGatewayHealthSnapshotMock,
}));

vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-snapshot.js")>()),
  getRuntimeConfigAppliedHash: () => "internal-applied-hash",
  getRuntimeConfigSourceSnapshot: () => null,
}));

vi.mock("../../infra/update-status-state.js", () => ({
  getUpdateAvailable: getUpdateAvailableMock,
  getUpdateSchedule: getUpdateScheduleMock,
}));

function expectCollection(index: number, expected: object) {
  expect(healthSnapshotCallArg(index)).toMatchObject(expected);
}

function healthSnapshotCallArg(index = 0) {
  return collectGatewayHealthSnapshotMock.mock.calls.at(index)?.[0];
}

function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
  };
}

const updateAvailable = {
  currentVersion: "2026.8.7",
  latestVersion: "2026.8.8",
  channel: "dev",
  currentSha: "1111111111111111111111111111111111111111",
  upstreamRef: "origin/main",
  upstreamSha: "2222222222222222222222222222222222222222",
  commitsBehind: 1,
  commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
};
const updateSchedule = { channel: "dev", autoEnabled: true, install: { kind: "git" as const } };

const revisionProjector = {
  projectRawHash: (hash: string) => `raw-token:${hash}`,
  projectResolvedHash: (hash: string) => `resolved-token:${hash}`,
  hashResponseSessionBearer: () => "unused-test-scope",
};

let healthState: typeof import("./health-state.js");

beforeEach(async () => {
  vi.restoreAllMocks();

  vi.resetModules();
  collectGatewayHealthSnapshotMock.mockReset();
  collectGatewayHealthSnapshotMock.mockResolvedValue(createHealthSummary());
  getUpdateAvailableMock.mockReset().mockReturnValue(null);
  getUpdateScheduleMock.mockReset().mockReturnValue(null);
  getRuntimeConfigMock.mockReset().mockReturnValue({ agents: { entries: { main: {} } } });
  healthState = await import("./health-state.js");
});

async function startRefresh(probe: boolean, includeSensitive = false) {
  // Enter collectors separately: Vitest manual mocks cannot resolve concurrent imports.
  const started = createDeferred();
  const pending = createDeferred<HealthSummary>();
  const summary = createHealthSummary();
  collectGatewayHealthSnapshotMock.mockImplementationOnce(() => {
    started.resolve();
    return pending.promise;
  });
  const result = healthState.refreshGatewayHealthSnapshot({ probe, includeSensitive });
  await started.promise;
  return { ...pending, summary, result, finish: () => pending.resolve(summary) };
}

describe("buildGatewaySnapshot update metadata", () => {
  it("reads suspension synchronously without waiting for health collection", async () => {
    resetGatewayWorkAdmission();
    const read = () =>
      healthState.buildGatewaySnapshot({ client: null, revisionProjector }).suspension;
    try {
      expect(read()).toEqual({ phase: "accepting" });
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(read()).toEqual({ phase: "preparing" });
      suspension?.drain();
      expect(read()).toEqual({ phase: "draining" });
      suspension?.commit();
      expect(read()).toEqual({ phase: "prepared" });
      suspension?.release();
      expect(read()).toEqual({ phase: "accepting" });
      expect(collectGatewayHealthSnapshotMock).not.toHaveBeenCalled();
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it.each([false, true])(
    "projects update metadata with detail access=%s",
    (includeUpdateDetails) => {
      getUpdateAvailableMock.mockReturnValue(updateAvailable);
      getUpdateScheduleMock.mockReturnValue(updateSchedule);
      const snapshot = healthState.buildGatewaySnapshot({
        client: null,
        includeUpdateDetails,
        revisionProjector,
      });
      if (includeUpdateDetails) {
        expect(snapshot.updateAvailable).toBe(updateAvailable);
        expect(snapshot.updateSchedule).toBe(updateSchedule);
      } else {
        expect(snapshot.updateAvailable).toEqual({
          currentVersion: "2026.8.7",
          latestVersion: "2026.8.8",
          channel: "dev",
        });
        expect(snapshot.updateSchedule).toBeUndefined();
        expect(snapshot.sessionDefaults).toMatchObject({
          ownership: "sole",
          selectionRequired: false,
        });
        expect(snapshot.appliedConfigHash).toBe("resolved-token:internal-applied-hash");
        expect(getUpdateScheduleMock).not.toHaveBeenCalled();
      }
    },
  );
});

describe("refreshGatewayHealthSnapshot", () => {
  it("does not let a post-connect passive refresh absorb an explicit probe", async () => {
    const broadcast = vi.fn();
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();
    const passive = await startRefresh(false);
    const probe = await startRefresh(true);
    const duplicate = healthState.refreshGatewayHealthSnapshot({ probe: true });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expectCollection(0, { audience: "public", probe: false, runtimeSnapshot: undefined });
    expectCollection(1, { audience: "public", probe: true, runtimeSnapshot: undefined });
    probe.finish();
    await expect(Promise.all([probe.result, duplicate])).resolves.toEqual([
      probe.summary,
      probe.summary,
    ]);
    expect(healthState.getHealthCache()).toBe(probe.summary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenLastCalledWith(probe.summary);

    passive.finish();
    await expect(passive.result).resolves.toBe(passive.summary);
    expect(healthState.getHealthCache()).toBe(passive.summary);
    expect(healthState.getHealthVersion()).toBe(version + 2);
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual([
      probe.summary,
      passive.summary,
    ]);
  });
  it("retains passive waiters and recovers a rejected probe lane", async () => {
    const passive = await startRefresh(false);
    const probe = await startRefresh(true);
    const recovered = createHealthSummary();
    collectGatewayHealthSnapshotMock.mockResolvedValueOnce(recovered);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    probe.reject(new Error("probe failed"));
    await expect(probe.result).rejects.toThrow("probe failed");

    const second = healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    passive.finish();
    await expect(Promise.all([passive.result, second])).resolves.toEqual([
      passive.summary,
      passive.summary,
    ]);
    expect(healthState.getHealthCache()).toBe(passive.summary);
    await expect(healthState.refreshGatewayHealthSnapshot({ probe: true })).resolves.toBe(
      recovered,
    );
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expect(healthState.getHealthCache()).toBe(recovered);
  });
  it.each([
    { includeSensitive: false, reset: false },
    { includeSensitive: false, reset: true },
    { includeSensitive: true, reset: false },
    { includeSensitive: true, reset: true },
  ])(
    "publishes current event-loop health after collection ($includeSensitive, $reset)",
    async ({ includeSensitive, reset }) => {
      const initial = {
        degraded: true,
        degradedSinceMs: 61_000,
        reasons: ["event_loop_delay" as const],
        intervalMs: 2_000,
        delayP99Ms: 1_500,
        delayMaxMs: 1_700,
        utilization: 0.2,
        cpuCoreRatio: 0.1,
      };
      let current: GatewayEventLoopHealth | undefined = initial;
      const started = createDeferred();
      const release = createDeferred();
      const broadcast = vi.fn();
      healthState.setBroadcastHealthUpdate(broadcast);
      collectGatewayHealthSnapshotMock.mockImplementationOnce(
        async (params: { eventLoop?: HealthSummary["eventLoop"] }) => {
          started.resolve();
          await release.promise;
          return {
            ...createHealthSummary(),
            ...(params.eventLoop ? { eventLoop: params.eventLoop } : {}),
          };
        },
      );
      const pending = healthState.refreshGatewayHealthSnapshot({
        probe: true,
        includeSensitive,
        getEventLoopHealth: () => current,
      });
      await started.promise;
      current = reset
        ? undefined
        : { ...initial, delayP99Ms: 20, delayMaxMs: 25, cpuCoreRatio: 1.2 };
      release.resolve();
      const result = await pending;
      expect(result.eventLoop).toBe(current);
      if (includeSensitive) {
        expect(broadcast).not.toHaveBeenCalled();
      } else {
        expect(healthState.getHealthCache()).toBe(result);
        expect(broadcast).toHaveBeenCalledExactlyOnceWith(result);
      }
    },
  );

  it("passes the config reloader hot-reload status only when the hook returns one", async () => {
    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getConfigReloaderHotReloadStatus: () => "disabled",
    });
    await healthState.refreshGatewayHealthSnapshot({
      probe: true,
      getConfigReloaderHotReloadStatus: () => undefined,
    });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()?.configReloadHotReloadStatus).toBe("disabled");
    expect(Object.hasOwn(healthSnapshotCallArg(1) ?? {}, "configReloadHotReloadStatus")).toBe(
      false,
    );
  });

  it("captures runtime snapshots for completed refreshes and guards snapshot failures", async () => {
    const runtimeSnapshot = {
      channels: { discord: { accountId: "default", connected: true } },
      channelAccounts: {},
    };

    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getRuntimeSnapshot: () => runtimeSnapshot,
    });
    await healthState.refreshGatewayHealthSnapshot({
      probe: true,
      getRuntimeSnapshot: () => {
        throw new Error("bad channel config");
      },
    });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expectCollection(0, { audience: "public", probe: false });
    expectCollection(1, { audience: "public", probe: true });
    expect(healthSnapshotCallArg()?.runtimeSnapshot).toBe(runtimeSnapshot);
    expect(healthSnapshotCallArg(1)?.runtimeSnapshot).toBeUndefined();
  });

  it("does not cache or broadcast sensitive health refreshes", async () => {
    const sensitiveSummary = createHealthSummary();
    const safeSummary = createHealthSummary();
    const broadcast = vi.fn();
    collectGatewayHealthSnapshotMock
      .mockResolvedValueOnce(sensitiveSummary)
      .mockResolvedValueOnce(safeSummary);
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();

    await healthState.refreshGatewayHealthSnapshot({ probe: true, includeSensitive: true });

    expect(healthState.getHealthCache()).toBeNull();
    expect(healthState.getHealthVersion()).toBe(version);
    expect(broadcast).not.toHaveBeenCalled();

    await healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(healthState.getHealthCache()).toBe(safeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledWith(safeSummary);
  });

  it("keeps strength-aware admin and public refresh lanes isolated", async () => {
    const adminPassive = await startRefresh(false, true);
    const publicProbe = await startRefresh(true);
    const publicPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const adminProbe = await startRefresh(true, true);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expectCollection(0, { audience: "admin", probe: false });
    expectCollection(1, { audience: "public", probe: true });
    expectCollection(2, { audience: "admin", probe: true });

    adminProbe.finish();
    publicProbe.finish();
    adminPassive.finish();
    await expect(adminProbe.result).resolves.toBe(adminProbe.summary);
    await expect(Promise.all([publicProbe.result, publicPassive])).resolves.toEqual([
      publicProbe.summary,
      publicProbe.summary,
    ]);
    await expect(adminPassive.result).resolves.toBe(adminPassive.summary);
    expect(healthState.getHealthCache()).toBe(publicProbe.summary);
  });
});
