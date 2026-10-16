/* @vitest-environment jsdom */

import type { TerminalAttachResult } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { refreshControlUiServiceWorker } from "../../app/sw-refresh.runtime.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  terminalSessionsForTest,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";

vi.mock("../../app/sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(),
}));

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const elementName = defineTestTerminalPanelElement(createGhosttyTerminalMock);

beforeAll(async () => {
  await import("@openclaw/libterminal/browser");
});

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  createGhosttyTerminalMock.mockReset();
  vi.mocked(refreshControlUiServiceWorker).mockReset();
  vi.unstubAllGlobals();
});

it("holds retained PTYs and queued actions behind the same-client reconnect refresh", async () => {
  const refresh = createDeferred<boolean>();
  const reattach = createDeferred<TerminalAttachResult>();
  vi.mocked(refreshControlUiServiceWorker).mockReturnValue(refresh.promise);
  createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
  let opened = 0;
  const request = createGatewayRequestMock((method) => {
    if (method === "terminal.open") {
      return terminalOpenResult(++opened === 1 ? "retained" : "queued");
    }
    if (method === "terminal.attach") {
      return reattach.promise;
    }
    return { ok: true };
  });
  const panel = createTestTerminalPanel(elementName);
  panel.client = createTestGatewayClient(request);
  panel.available = true;
  document.body.append(panel);
  panel.toggle();
  const sessions = terminalSessionsForTest(panel);
  await waitForFast(() => expect(sessions.tabs[0]?.gatewaySessionId).toBe("retained"));
  const tab = sessions.tabs[0]!;
  const terminal = tab.controller;

  panel.gatewayConnected = false;
  await panel.updateComplete;
  await waitForFast(() => expect(terminal.setReadOnly).toHaveBeenCalledWith(true));
  await sessions.openSession();
  expect(opened).toBe(1);

  panel.gatewayConnected = true;
  await panel.updateComplete;
  await waitForFast(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
  expect(request.mock.calls.filter(([method]) => method === "terminal.attach")).toEqual([]);
  expect(opened).toBe(1);
  expect(sessions.tabs).toEqual([tab]);
  expect(terminal.dispose).not.toHaveBeenCalled();

  refresh.resolve(false);
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "terminal.attach")).toHaveLength(1),
  );
  expect(opened).toBe(1);
  expect(terminal.setReadOnly).toHaveBeenLastCalledWith(true);
  reattach.resolve({ ...terminalOpenResult("retained"), buffer: "", seq: 0 });
  await waitForFast(() => {
    expect(sessions.tabs.map((entry) => entry.gatewaySessionId)).toEqual(["retained", "queued"]);
    expect(terminal.setReadOnly).toHaveBeenLastCalledWith(false);
  });
  expect(request.mock.calls.filter(([method]) => method === "terminal.attach")).toHaveLength(1);
  expect(opened).toBe(2);
  expect(sessions.tabs[0]).toBe(tab);
  expect(tab.controller).toBe(terminal);
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(panel.renderRoot.querySelector(".tp-error")).toBeNull();
});

it("exits a confirmed missing retained PTY without leaving its surviving tab read-only", async () => {
  vi.mocked(refreshControlUiServiceWorker).mockResolvedValue(false);
  createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
  let opened = 0;
  const request = createGatewayRequestMock((method, params) => {
    if (method === "terminal.open") {
      return terminalOpenResult(++opened === 1 ? "expired" : "survivor");
    }
    if (method === "terminal.attach") {
      return isRecord(params) && params.sessionId === "expired"
        ? Promise.reject(new Error('unknown terminal session "expired"'))
        : { ...terminalOpenResult("survivor"), buffer: "", seq: 0 };
    }
    if (method === "terminal.list") {
      return { sessions: [{ ...terminalOpenResult("survivor"), attached: true, createdAtMs: 1 }] };
    }
    return { ok: true };
  });
  const panel = createTestTerminalPanel(elementName);
  panel.client = createTestGatewayClient(request);
  panel.available = true;
  document.body.append(panel);
  panel.toggle();
  const sessions = terminalSessionsForTest(panel);
  await waitForFast(() => expect(sessions.tabs[0]?.status).toBe("live"));
  await sessions.openSession();
  await waitForFast(() => expect(sessions.tabs[1]?.status).toBe("live"));
  const [expired, survivor] = sessions.tabs;
  expect(expired?.gatewaySessionId).toBe("expired");
  expect(survivor?.gatewaySessionId).toBe("survivor");

  panel.gatewayConnected = false;
  await panel.updateComplete;
  await waitForFast(() => {
    expect(expired!.controller.setReadOnly).toHaveBeenLastCalledWith(true);
    expect(survivor!.controller.setReadOnly).toHaveBeenLastCalledWith(true);
  });
  panel.gatewayConnected = true;
  await panel.updateComplete;
  await waitForFast(() => {
    expect(expired!.status).toBe("exited");
    expect(survivor!.status).toBe("live");
    expect(survivor!.controller.setReadOnly).toHaveBeenLastCalledWith(false);
    expect(panel.hostedTabs.map((tab) => tab.className)).toEqual(["is-exited", "is-live"]);
  });
  expect(expired!.controller.setReadOnly).toHaveBeenLastCalledWith(true);
  expect(sessions.tabs).toEqual([expired, survivor]);
  expect(expired!.controller.dispose).not.toHaveBeenCalled();
  expect(survivor!.controller.dispose).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe('["survivor"]');
  expect(panel.renderRoot.querySelector(".tp-error")).toBeNull();
});
