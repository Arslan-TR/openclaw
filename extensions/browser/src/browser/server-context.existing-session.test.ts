import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import type { BrowserServerState } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

const braveProfileDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-brave-profile-")),
);

afterAll(() => {
  fs.rmSync(braveProfileDir, { recursive: true, force: true });
});

const chromeMcpMock = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => true),
  countChromeMcpTabs: vi.fn(
    async (
      _profileName: string,
      _profile: unknown,
      _options?: { ephemeral?: boolean; signal?: AbortSignal },
    ) => 1,
  ),
  ensureChromeMcpAvailable: vi.fn(
    async (
      profileName: string,
      profile: unknown,
      options?: {
        signal?: AbortSignal;
        pageProbe?: { onResult: (tabCount: number | null) => void };
      },
    ) => {
      if (!options?.pageProbe) {
        return;
      }
      try {
        options.pageProbe.onResult(
          await chromeMcpMock.countChromeMcpTabs(profileName, profile, {
            ephemeral: true,
            signal: options.signal,
          }),
        );
      } catch {
        options.pageProbe.onResult(null);
      }
    },
  ),
  focusChromeMcpTab: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => [
    { targetId: "7", title: "", url: "https://example.com", type: "page" },
  ]),
  openChromeMcpTab: vi.fn(async () => ({
    targetId: "8",
    title: "",
    url: "about:blank",
    type: "page",
  })),
  closeChromeMcpTab: vi.fn(async () => {}),
  getChromeMcpPid: vi.fn(() => 4321),
}));

vi.mock("./chrome-mcp.js", () => chromeMcpMock);

const { createBrowserRouteContext } = await import("./server-context.js");
const chromeMcp = chromeMcpMock;

function tab(targetId: string, url: string, title = "") {
  return { targetId, title, url, type: "page" as const };
}

function makeState(): BrowserServerState {
  const settings = {
    cdpPort: 18801,
    color: "#0066CC",
    driver: "existing-session" as const,
    attachOnly: true,
    userDataDir: braveProfileDir,
  };
  return makeBrowserServerState({
    profile: makeBrowserProfile({ name: "chrome-live", ...settings }),
    resolvedOverrides: {
      evaluateEnabled: true,
      headless: false,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      profiles: { "chrome-live": settings },
    },
  });
}

function liveProfile(state = makeState()) {
  return createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");
}

function mockCachedSessionClose() {
  let cached = true;
  const results: boolean[] = [];
  chromeMcp.closeChromeMcpSession.mockReset().mockImplementation(async () => {
    const closed = cached;
    cached = false;
    results.push(closed);
    return closed;
  });
  return results;
}

function expectClosedSession(results: boolean[]) {
  expect(chromeMcp.closeChromeMcpSession.mock.calls).toEqual([["chrome-live"], ["chrome-live"]]);
  expect(results).toEqual([true, false]);
}

beforeEach(() => {
  for (const key of [
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  chromeMcp.listChromeMcpTabs.mockReset().mockResolvedValue([tab("7", "https://example.com")]);
  chromeMcp.countChromeMcpTabs.mockReset().mockResolvedValue(1);
  chromeMcp.openChromeMcpTab.mockReset().mockResolvedValue(tab("8", "about:blank"));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("browser server-context existing-session profile", () => {
  it("fails closed for Chrome MCP endpoint mcpArgs under the default CDP policy", async () => {
    const state = makeState();
    state.resolved.ssrfPolicy = {};
    state.resolved.profiles["chrome-live"] = {
      ...state.resolved.profiles["chrome-live"],
      mcpArgs: ["--browserUrl", "http://127.0.0.1:9222"],
    };
    const live = liveProfile(state);

    await expect(live.listTabs()).rejects.toThrow(/Chrome MCP cannot carry that pinned transport/);
    await expect(live.openTab("https://example.com")).rejects.toThrow(
      /remove cdpUrl and browserUrl\/wsEndpoint mcpArgs/,
    );
    await expect(live.ensureBrowserAvailable()).rejects.toThrow(/host-local Chrome profile/);

    expect(chromeMcp.listChromeMcpTabs).not.toHaveBeenCalled();
    expect(chromeMcp.openChromeMcpTab).not.toHaveBeenCalled();
    expect(chromeMcp.ensureChromeMcpAvailable).not.toHaveBeenCalled();
  });

  it("reports endpoint cdpUrl for existing-session profiles", async () => {
    const state = makeState();
    const chromeLiveProfile = expectDefined(
      state.resolved.profiles["chrome-live"],
      "chrome-live browser profile",
    );
    state.resolved.ssrfPolicy = undefined;
    state.resolved.profiles["chrome-live"] = {
      ...chromeLiveProfile,
      cdpUrl: "http://openclaw:relay-token@127.0.0.1:9222",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });

    const profiles = await ctx.listProfiles();

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      transport: "chrome-mcp",
      cdpPort: null,
      cdpUrl: "http://127.0.0.1:9222",
    });
    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      expect.objectContaining({ cdpUrl: "http://openclaw:relay-token@127.0.0.1:9222" }),
      expect.anything(),
    );
  });

  it("eagerly closes MCP while attach readiness is pending and prevents retry", async () => {
    const readinessEntered = Promise.withResolvers<void>();
    const readiness = Promise.withResolvers<never>();
    chromeMcp.listChromeMcpTabs.mockImplementationOnce(async () => {
      readinessEntered.resolve();
      return await readiness.promise;
    });
    const closeResults = mockCachedSessionClose();
    const state = makeState();
    const live = liveProfile(state);

    const starting = live.ensureBrowserAvailable();
    await readinessEntered.promise;
    const stopping = live.stopRunningBrowser();
    await vi.waitFor(() => expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(1));
    readiness.reject(new Error("attach not ready"));

    await expect(starting).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(stopping).resolves.toEqual({ stopped: true });
    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledTimes(1);
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledTimes(1);
    expectClosedSession(closeResults);
  });

  it("drains an admitted MCP tab open before the final session sweep", async () => {
    const openEntered = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<ReturnType<typeof tab>>();
    chromeMcp.openChromeMcpTab.mockImplementationOnce(async () => {
      openEntered.resolve();
      return await opened.promise;
    });
    const closeResults = mockCachedSessionClose();
    const state = makeState();
    const live = liveProfile(state);

    await live.ensureTabAvailable();
    const aliasesBefore = structuredClone(state.profiles.get("chrome-live")?.tabAliases);
    const opening = live.openTab("about:blank");
    await openEntered.promise;
    const stopping = live.stopRunningBrowser();
    await vi.waitFor(() => expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(1));
    opened.resolve(tab("late", "about:blank"));

    await expect(opening).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(stopping).resolves.toEqual({ stopped: true });
    expect(chromeMcp.openChromeMcpTab).toHaveBeenCalledTimes(1);
    expectClosedSession(closeResults);
    expect(state.profiles.get("chrome-live")?.lastTargetId).toBe("7");
    expect(state.profiles.get("chrome-live")?.tabAliases).toEqual(aliasesBefore);
  });

  it("expires Chrome MCP aliases instead of transferring them to a replacement tab", async () => {
    const originalTab = tab("TARGET-A", "https://shop.example/checkout", "Checkout");
    const replacementTab = { ...originalTab, targetId: "TARGET-B" };
    let currentTabs = [originalTab];
    chromeMcp.listChromeMcpTabs.mockImplementation(async () => currentTabs);
    const state = makeState();
    const live = liveProfile(state);

    await expect(live.listTabs()).resolves.toEqual([
      expect.objectContaining({ targetId: "TARGET-A", tabId: "t1" }),
    ]);
    await live.labelTab("t1", "checkout");
    await expect(live.ensureTabAvailable()).resolves.toMatchObject({ targetId: "TARGET-A" });

    currentTabs = [replacementTab];
    await expect(live.listTabs()).resolves.toEqual([
      expect.objectContaining({
        targetId: "TARGET-B",
        tabId: "t2",
        suggestedTargetId: "t2",
      }),
    ]);
    await expect(live.ensureTabAvailable()).rejects.toThrow(/tab not found/i);
    await expect(live.ensureTabAvailable("t1")).rejects.toThrow(/tab not found/i);
    await expect(live.ensureTabAvailable("checkout")).rejects.toThrow(/tab not found/i);
    await expect(live.ensureTabAvailable("TARGET-B")).resolves.toEqual(
      expect.objectContaining({ targetId: "TARGET-B", tabId: "t2" }),
    );
  });

  it("does not sticky-adopt a Chrome MCP tab when the final URL is policy-blocked", async () => {
    const goodTab = tab("chrome-mcp:good:1", "https://example.com/", "Good");
    const blockedTargetId = "chrome-mcp:blocked:1";
    const blockedTab = tab(blockedTargetId, "http://127.0.0.1:9/", "Blocked");
    chromeMcp.openChromeMcpTab.mockResolvedValueOnce(goodTab).mockResolvedValueOnce(blockedTab);
    chromeMcp.listChromeMcpTabs.mockResolvedValue([goodTab, blockedTab]);
    const state = makeState();
    state.resolved.ssrfPolicy = {};
    const live = liveProfile(state);

    await expect(live.openTab("https://example.com", { label: "good" })).resolves.toEqual(
      expect.objectContaining({ targetId: goodTab.targetId }),
    );
    expect(state.profiles.get("chrome-live")?.lastTargetId).toBe(goodTab.targetId);

    await expect(
      live.openTab("https://example.com/redirect", { label: "blocked" }),
    ).rejects.toThrow(/private|blocked|ssrf/i);
    const profileState = state.profiles.get("chrome-live");
    expect(profileState?.lastTargetId).toBe(goodTab.targetId);
    expect(profileState?.lastTargetId).not.toBe(blockedTargetId);
    expect(profileState?.tabAliases).toEqual({
      nextTabNumber: 2,
      byTargetId: {
        [goodTab.targetId]: {
          tabId: "t1",
          label: "good",
          url: goodTab.url,
        },
      },
    });

    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: goodTab.targetId }),
    );
  });

  it("clears only the sticky Chrome MCP target after a successful close", async () => {
    const tabA = tab("chrome-mcp:fresh:1", "https://a.example", "A");
    const tabB = tab("chrome-mcp:fresh:2", "https://b.example", "B");
    let currentTabs = [tabA, tabB];
    chromeMcp.listChromeMcpTabs.mockImplementation(async () => currentTabs);
    const state = makeState();
    const live = liveProfile(state);

    await live.focusTab(tabA.targetId);
    expect(chromeMcp.focusChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      tabA.targetId,
      expect.objectContaining({ driver: "existing-session" }),
      { signal: expect.any(AbortSignal) },
    );
    chromeMcp.closeChromeMcpTab.mockRejectedValueOnce(new Error("close failed"));
    await expect(live.closeTab(tabA.targetId)).rejects.toThrow("close failed");
    expect(state.profiles.get("chrome-live")?.lastTargetId).toBe(tabA.targetId);
    await expect(live.ensureTabAvailable()).resolves.toMatchObject({ targetId: tabA.targetId });
    await live.closeTab(tabA.targetId);
    expect(chromeMcp.closeChromeMcpTab).toHaveBeenNthCalledWith(
      2,
      "chrome-live",
      tabA.targetId,
      expect.objectContaining({ driver: "existing-session" }),
      { signal: expect.any(AbortSignal) },
    );
    currentTabs = [tabB];
    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: tabB.targetId }),
    );

    currentTabs = [tabA, tabB];
    await live.ensureTabAvailable(tabA.targetId);
    await live.closeTab(tabB.targetId);
    expect(chromeMcp.closeChromeMcpTab).toHaveBeenNthCalledWith(
      3,
      "chrome-live",
      tabB.targetId,
      expect.objectContaining({ driver: "existing-session" }),
      { signal: expect.any(AbortSignal) },
    );
    currentTabs = [tabA];
    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: tabA.targetId }),
    );
  });

  it("surfaces DevToolsActivePort attach failures instead of a generic tab timeout", async () => {
    vi.useFakeTimers();
    chromeMcp.listChromeMcpTabs.mockRejectedValue(
      new Error(
        `Could not connect to Chrome. Check if Chrome is running. Cause: Could not find DevToolsActivePort for chrome at ${braveProfileDir}/DevToolsActivePort`,
      ),
    );

    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    const pending = live.ensureBrowserAvailable();
    const assertion = expect(pending).rejects.toThrow(
      /could not connect to Chrome.*managed "openclaw" profile.*DevToolsActivePort/s,
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });
});
