import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  installRemoteProfileTestLifecycle,
  loadRemoteProfileTestDeps,
} from "./server-context.remote-profile-tab-ops.test-helpers.js";

const deps = await loadRemoteProfileTestDeps();
installRemoteProfileTestLifecycle(deps);

function versionResponse() {
  return Response.json({
    webSocketDebuggerUrl: "wss://1.1.1.1:9222/devtools/browser/REMOTE-BROWSER?auth=fixture-value",
  });
}

function page(
  targetId: string,
  url = `https://${targetId.toLowerCase()}.example`,
  title = targetId === "T1" ? "Tab 1" : targetId,
) {
  return { targetId, title, url, type: "page" as const };
}

type PwModule = NonNullable<Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>>;
type PwMocks = Partial<Omit<PwModule, "createPageViaPlaywright">> & {
  createPageViaPlaywright?: () => Promise<
    ReturnType<typeof page> & { close?: () => Promise<void> }
  >;
};

function mockPlaywright<T extends PwMocks>(methods: T): T {
  vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(methods as unknown as PwModule);
  return methods;
}

function remoteHarness<T extends PwMocks>(methods: T) {
  return { pw: mockPlaywright(methods), ...deps.createRemoteRouteHarness() };
}

async function expectBlockedCdpEndpoint(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    name: "BrowserCdpEndpointBlockedError",
    status: 400,
  });
}

const permissiveRemoteCdpPolicy = {
  allowPrivateNetwork: true,
  allowedHostnames: ["1.1.1.1"],
};
const cdpOptions = {
  cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
  ssrfPolicy: permissiveRemoteCdpPolicy,
};
const createOptions = {
  ...cdpOptions,
  cdpPolicy: permissiveRemoteCdpPolicy,
  ssrfPolicy: { allowPrivateNetwork: true },
};

describe("browser remote profile tab ops via Playwright", () => {
  it("uses Playwright tab operations when available", async () => {
    const pw = mockPlaywright({
      listPagesViaPlaywright: vi.fn(async () => [page("T1", "https://example.com")]),
      createPageViaPlaywright: vi.fn(async () => page("T2", "http://127.0.0.1:3000", "Tab 2")),
      closePageByTargetIdViaPlaywright: vi.fn(async () => {}),
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain("/json/version");
      return versionResponse();
    });
    const { state, remote } = deps.createRemoteRouteHarness(fetchMock);

    expect((await remote.listTabs()).map((t) => t.targetId)).toEqual(["T1"]);
    expect(pw.listPagesViaPlaywright).toHaveBeenCalledWith({ ...cdpOptions, timeoutMs: 60_000 });

    const opened = await remote.openTab("http://127.0.0.1:3000", { timeoutMs: 60_000 });
    expect(opened).toMatchObject({
      targetId: "T2",
      ownership: {
        status: "durable",
        nativeTargetId: "T2",
        profileFingerprint: expect.stringMatching(/^sha256:/),
        browserInstanceFingerprint: expect.stringMatching(/^sha256:/),
      },
    });
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T2");
    expect(pw.createPageViaPlaywright).toHaveBeenCalledWith({
      ...createOptions,
      url: "http://127.0.0.1:3000",
      timeoutMs: 60_000,
    });

    await remote.closeTab("T1");
    expect(pw.closePageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      ...cdpOptions,
      targetId: "T1",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards a caller-supplied enumeration deadline instead of the handshake timeout", async () => {
    const pw = mockPlaywright({
      listPagesViaPlaywright: vi.fn(async () => [page("T1", "https://example.com")]),
    });
    const { remote } = deps.createRemoteRouteHarness(vi.fn(async () => versionResponse()));

    await remote.listTabs({ timeoutMs: 45_000 });

    expect(pw.listPagesViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 45_000 }),
    );
  });

  it("preserves ownership cancellation when closing the exact created page fails", async () => {
    const close = vi.fn(async () => {
      throw new Error("created page close failed");
    });
    mockPlaywright({
      createPageViaPlaywright: vi.fn(async () => ({ ...page("T2"), close })),
    });
    const probeStarted = Promise.withResolvers<void>();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/json/close/T2")) {
        return new Response(null, { status: 404 });
      }
      return await new Promise<Response>((_resolve, reject) => {
        probeStarted.resolve();
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const { remote } = deps.createRemoteRouteHarness(fetchMock);
    const controller = new AbortController();
    const abortError = new Error("caller aborted ownership probe");

    const opening = remote.openTab("https://t2.example", { signal: controller.signal });
    await probeStarted.promise;
    controller.abort(abortError);

    await expect(opening).rejects.toBe(abortError);
    expect(close).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/json/version"),
    ]);
  });

  it("assigns stable tab ids and resolves labels", async () => {
    const { pw, state, remote, fetchMock } = remoteHarness({
      listPagesViaPlaywright: vi.fn(async () => [page("A"), page("B")]),
      focusPageByTargetIdViaPlaywright: vi.fn(async () => {}),
    });

    const tabs = await remote.listTabs();
    expect(tabs).toMatchObject([
      { targetId: "A", tabId: "t1", suggestedTargetId: "t1" },
      { targetId: "B", tabId: "t2", suggestedTargetId: "t2" },
    ]);

    await expect(remote.labelTab("t2", "docs")).resolves.toMatchObject({
      targetId: "B",
      suggestedTargetId: "docs",
      tabId: "t2",
      label: "docs",
    });

    await remote.focusTab("docs");
    expect(pw.focusPageByTargetIdViaPlaywright).toHaveBeenNthCalledWith(1, {
      ...cdpOptions,
      targetId: "B",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("remote")?.lastTargetId).toBe("B");

    await remote.labelTab("t1", "B");
    await expect(remote.focusTab("B")).rejects.toThrow("ambiguous browser tab reference");
    await remote.focusTab("B", { exactTargetId: true });
    expect(pw.focusPageByTargetIdViaPlaywright).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ targetId: "B" }),
    );
  });

  it("migrates only unique URL groups alongside ambiguous duplicate groups", async () => {
    const group = (ids: string[]) =>
      ids.map((id, i) => page(id, `https://${i ? "duplicate" : "unique"}.example`));
    let currentPages = group(["A", "B", "C"]);
    const { state, remote } = remoteHarness({
      listPagesViaPlaywright: vi.fn(async () => currentPages),
    });

    expect((await remote.listTabs()).map((tab) => [tab.targetId, tab.tabId])).toEqual([
      ["A", "t1"],
      ["B", "t2"],
      ["C", "t3"],
    ]);
    await remote.labelTab("t1", "unique");
    state.profiles.get("remote")!.lastTargetId = "A";

    currentPages = group(["D", "E", "F"]);

    await expect(remote.listTabs()).resolves.toMatchObject([
      { targetId: "D", tabId: "t1", label: "unique", suggestedTargetId: "unique" },
      { targetId: "E", tabId: "t4", suggestedTargetId: "t4" },
      { targetId: "F", tabId: "t5", suggestedTargetId: "t5" },
    ]);
    expect(state.profiles.get("remote")?.lastTargetId).toBe("D");
  });

  it("opens a real remote Playwright tab when only browser-internal targets are listed", async () => {
    const internalTab = page("OMNI", "chrome://omnibox-popup.top-chrome/", "Omnibox Popup");
    const realTab = page("REAL", "about:blank", "New Tab");
    const { pw, state, remote } = remoteHarness({
      listPagesViaPlaywright: vi.fn(
        deps.createSequentialPageLister([[internalTab], [internalTab, realTab]]),
      ),
      createPageViaPlaywright: vi.fn(async () => realTab),
    });

    const selected = await remote.ensureTabAvailable();
    expect(selected.targetId).toBe("REAL");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("REAL");
    expect(pw.createPageViaPlaywright).toHaveBeenCalledWith({
      ...createOptions,
      url: "about:blank",
    });
  });

  it.each([false, true])(
    "unavailable identities never create a tab (prior list: %s)",
    async (priorList) => {
      const list = vi.fn<() => Promise<ReturnType<typeof page>[]>>();
      if (priorList) {
        list.mockResolvedValueOnce([page("A"), page("B")]);
      }
      list.mockRejectedValueOnce(
        new Error("Playwright page target identities are temporarily unavailable."),
      );
      const { pw, remote, fetchMock } = remoteHarness({
        listPagesViaPlaywright: list,
        createPageViaPlaywright: vi.fn(async () => page("WRONG", "about:blank")),
      });
      if (priorList) {
        await expect(remote.ensureTabAvailable("B")).resolves.toMatchObject({ targetId: "B" });
      } else {
        await expect(remote.ensureTabAvailable()).rejects.toThrow(
          /target identities.*unavailable/i,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      }
      expect(pw.createPageViaPlaywright).not.toHaveBeenCalled();
    },
  );

  it("blocks remote Playwright tab operations when strict SSRF hostname allowlist rejects the cdpUrl", async () => {
    const pw = mockPlaywright({
      listPagesViaPlaywright: vi.fn(async () => [page("T1")]),
      focusPageByTargetIdViaPlaywright: vi.fn(async () => {}),
      closePageByTargetIdViaPlaywright: vi.fn(async () => {}),
    });

    const state = deps.makeState("remote");
    state.resolved.ssrfPolicy = {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["browserless.example.com"],
    };
    expectDefined(state.resolved.profiles.remote, "remote browser profile").cdpUrl =
      "http://10.0.0.42:9222";
    const remote = deps.createBrowserRouteContext({ getState: () => state }).forProfile("remote");

    await expectBlockedCdpEndpoint(remote.listTabs());
    await expectBlockedCdpEndpoint(remote.focusTab("T1"));
    await expectBlockedCdpEndpoint(remote.closeTab("T1"));
    expect(pw.listPagesViaPlaywright).not.toHaveBeenCalled();
    expect(pw.focusPageByTargetIdViaPlaywright).not.toHaveBeenCalled();
    expect(pw.closePageByTargetIdViaPlaywright).not.toHaveBeenCalled();
  });
});

function createExtensionProfile(targetIds = ["TARGET-41"]) {
  mockPlaywright({
    listPagesViaPlaywright: vi.fn(async () =>
      targetIds.map((targetId) => page(targetId, "https://example.com/login", "Extension test")),
    ),
  });
  const state = deps.makeState("openclaw");
  state.resolved.profiles.chrome = {
    cdpUrl: "http://127.0.0.1:18799",
    cdpPort: 18799,
    color: "#FF4500",
    driver: "extension",
  };
  return deps.createTestBrowserRouteContext({ getState: () => state }).forProfile("chrome");
}

describe("browser extension profile tab ops", () => {
  it("matches native ids by CDP target despite identical page metadata and different order", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        [42, 99, 41, 43].map((tabId) => ({
          id: `TARGET-${tabId}`,
          tabId: tabId === 43 ? "43" : tabId,
          title: "Extension test",
          url: "https://example.com/login",
          type: "page",
        })),
      ),
    );

    const tabs = await createExtensionProfile(["TARGET-41", "TARGET-42", "TARGET-43"]).listTabs();

    expect(tabs).toMatchObject([
      { targetId: "TARGET-41", tabId: "t1", webExtensionTabId: 41 },
      { targetId: "TARGET-42", tabId: "t2", webExtensionTabId: 42 },
      { targetId: "TARGET-43", tabId: "t3" },
    ]);
    expect(tabs[2]).not.toHaveProperty("webExtensionTabId");
  });

  it("preserves caller cancellation during the native extension metadata request", async () => {
    const controller = new AbortController();
    const reason = new Error("tab listing cancelled");
    let fetchSignal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      fetchSignal = init?.signal;
      controller.abort(reason);
      throw reason;
    });

    await expect(createExtensionProfile().listTabs({ signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(fetchSignal?.aborted).toBe(true);
  });
});
