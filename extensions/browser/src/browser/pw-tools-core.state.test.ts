import { beforeEach, expect, it, vi } from "vitest";
import type { PageState } from "./pw-session-contracts.js";

const stateMocks = vi.hoisted(() => ({
  ensurePageState: vi.fn(),
  getPageForTargetId: vi.fn(),
  devices: {
    "iPhone 14": {
      userAgent: "phone",
      viewport: { width: 750, height: 340 },
      screen: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
    "Desktop Chrome": {
      userAgent: "desktop",
      viewport: { width: 1280, height: 720 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
  },
}));

vi.mock("./playwright-core.runtime.js", () => ({
  getPlaywrightCore: () => ({ devices: stateMocks.devices }),
}));

vi.mock("./pw-session.js", () => ({
  ensurePageState: stateMocks.ensurePageState,
  getPageForTargetId: stateMocks.getPageForTargetId,
}));

import {
  setDeviceViaPlaywright,
  setGeolocationViaPlaywright,
  setLocaleViaPlaywright,
  setTimezoneViaPlaywright,
} from "./pw-tools-core.state.js";

function createPage() {
  const state: Partial<PageState> = {};
  stateMocks.ensurePageState.mockReturnValue(state);
  const send = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({}));
  const detach = vi.fn(async () => {});
  const newCDPSession = vi.fn(async () => ({ send, detach }));
  const setViewportSize = vi.fn(async (_value: { width: number; height: number }) => {});
  stateMocks.getPageForTargetId.mockResolvedValue({
    context: () => ({ newCDPSession }),
    setViewportSize,
  });
  return { state, send, detach, newCDPSession, setViewportSize };
}

const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "tab-1" };

beforeEach(() => vi.clearAllMocks());

it("keeps one page-scoped CDP session attached for persistent emulation", async () => {
  const fixture = createPage();

  await setTimezoneViaPlaywright({ ...target, timezoneId: "America/New_York" });
  await setLocaleViaPlaywright({ ...target, locale: "en-GB" });

  expect(fixture.newCDPSession).toHaveBeenCalledTimes(1);
  expect(fixture.detach).not.toHaveBeenCalled();
  expect(fixture.send.mock.calls).toEqual([
    ["Emulation.setTimezoneOverride", { timezoneId: "America/New_York" }],
    ["Emulation.setLocaleOverride", { locale: "en-GB" }],
  ]);
});

it("keeps the successful Playwright viewport when a later device override fails", async () => {
  const fixture = createPage();
  await setDeviceViaPlaywright({ ...target, name: "iPhone 14" });
  fixture.send.mockImplementation(async (method) => {
    if (method === "Emulation.setDeviceMetricsOverride") {
      throw new Error("metrics override failed");
    }
    return {};
  });

  await expect(setDeviceViaPlaywright({ ...target, name: "Desktop Chrome" })).rejects.toThrow(
    "metrics override failed",
  );

  expect(fixture.setViewportSize).toHaveBeenLastCalledWith({ width: 1280, height: 720 });
  expect(fixture.state.emulation?.metricsOwner).toBeUndefined();
  expect(fixture.state.emulation?.touch?.enabled).toBe(true);
});

it("serializes overlapping descriptor transitions on the same page", async () => {
  const firstUserAgentBlocked = Promise.withResolvers<void>();
  const { send, detach, newCDPSession, setViewportSize } = createPage();
  send.mockImplementation(async (method, params) => {
    if (method === "Emulation.setUserAgentOverride" && params?.userAgent === "phone") {
      await firstUserAgentBlocked.promise;
    }
    return {};
  });

  const phone = setDeviceViaPlaywright({ ...target, name: "iPhone 14" });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const desktop = setDeviceViaPlaywright({ ...target, name: "Desktop Chrome" });

  await Promise.resolve();
  const whileBlocked = [setViewportSize.mock.calls.length, send.mock.calls.length];

  firstUserAgentBlocked.resolve();
  await Promise.all([phone, desktop]);
  expect(whileBlocked).toEqual([1, 1]);
  expect(setViewportSize.mock.calls).toEqual([
    [{ width: 750, height: 340 }],
    [{ width: 1280, height: 720 }],
  ]);
  // Independent CDP payloads: phone first, desktop second.
  const orient = (type: string) => ({ angle: 0, type });
  const metrics = [
    ["mobile", true, false],
    ["width", 750, 1280],
    ["height", 340, 720],
    ["deviceScaleFactor", 3, 1],
    ["screenWidth", 390, 1920],
    ["screenHeight", 844, 1080],
    ["screenOrientation", orient("portraitPrimary"), orient("landscapePrimary")],
  ] as const;
  const payload = (column: 1 | 2) =>
    Object.fromEntries(metrics.map((row) => [row[0], row[column]]));
  expect(send.mock.calls).toEqual([
    ["Emulation.setUserAgentOverride", { userAgent: "phone" }],
    ["Emulation.setDeviceMetricsOverride", payload(1)],
    ["Emulation.setTouchEmulationEnabled", { enabled: true }],
    ["Emulation.clearDeviceMetricsOverride"],
    ["Emulation.setUserAgentOverride", { userAgent: "desktop" }],
    ["Emulation.setDeviceMetricsOverride", payload(2)],
    ["Emulation.setTouchEmulationEnabled", { enabled: false }],
  ]);
  expect(newCDPSession).toHaveBeenCalledTimes(1);
  expect(detach).not.toHaveBeenCalled();
});
it.each(["before", "after"] as const)(
  "settles geolocation clear cleanup when authority is revoked %s admission",
  async (revoked) => {
    let current = revoked !== "before";
    const setGeolocation = vi.fn(async () => {
      current = false;
    });
    const clearPermissions = vi.fn(async () => {});
    stateMocks.getPageForTargetId.mockResolvedValue({
      context: () => ({ setGeolocation, clearPermissions }),
    });
    const clearing = setGeolocationViaPlaywright({
      ...target,
      clear: true,
      assertCurrent: async () => {
        if (!current) {
          throw new Error("dashboard owner stopped");
        }
      },
    });
    if (revoked === "before") {
      await expect(clearing).rejects.toThrow("dashboard owner stopped");
    } else {
      await expect(clearing).resolves.toBeUndefined();
    }
    expect(setGeolocation.mock.calls).toEqual(revoked === "before" ? [] : [[null]]);
    expect(clearPermissions).toHaveBeenCalledTimes(revoked === "before" ? 0 : 1);
  },
);
