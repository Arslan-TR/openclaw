import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { serveCompanion } from "./native-desktop.test-support.ts";
import { expectControl, nativeForm } from "./native-form.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native desktop Gateways E2E" });
const companionFile = (file: string) =>
  readFileSync(new URL(`../../../apps/linux/ui/${file}`, import.meta.url), "utf8");
const snapshot: NativeGatewaysSnapshot = {
  currentId: "primary",
  gateways: [
    {
      id: "primary",
      name: "Local Gateway",
      kind: "local",
      isPrimary: true,
      canPromote: false,
      health: "ok",
    },
    {
      id: "profile:studio",
      name: "Studio",
      kind: "remote",
      isPrimary: false,
      canPromote: true,
      health: "unknown",
    },
  ],
};
type GatewayRequest = {
  command: string;
  params: { message: { type: string; id?: string }; token: string };
};
const gatewayRequest = (token: string, message: GatewayRequest["params"]["message"]) => ({
  command: "gateway_request",
  params: { message, token },
});
const profileRequests = (page: Page) =>
  page.evaluate(() => Reflect.get(window, "profileRequests") as Array<Record<string, unknown>>);
const postGateway = (page: Page, message: GatewayRequest["params"]["message"]) =>
  page.evaluate((request) => {
    const { postMessage } = Reflect.get(window, "webkit").messageHandlers.openclawGateways;
    return postMessage(request);
  }, message);

const waitNotice = (page: Page, hasText: string, role: "alert" | "status" = "status") =>
  page.getByRole(role).filter({ hasText }).waitFor();
const requestsOf = async (page: Page, action: string) =>
  (await profileRequests(page)).filter((message) => message.action === action);
const lastRequest = async (page: Page, action: string) => (await requestsOf(page, action)).at(-1);

async function showNotice(page: Page, message: string) {
  await page.evaluate((notice) => {
    window.dispatchEvent(
      new CustomEvent("openclaw:gateway-notice", { detail: { message: notice } }),
    );
  }, message);
}

async function updateProfiles(
  page: Page,
  updates: Array<{ profile: Record<string, unknown>; detail?: Record<string, string> }>,
) {
  await page.evaluate((changes) => {
    const catalog = Reflect.get(window, "profileCatalog") as Array<Record<string, unknown>>;
    for (const { profile, detail = {} } of changes) {
      catalog[0] = { ...catalog[0], ...profile };
      window.dispatchEvent(new CustomEvent("openclaw:gateway-profiles-changed", { detail }));
    }
  }, updates);
}

async function installAdapter(page: Page, config?: { origin?: string; base?: string }) {
  await page.addInitScript({
    content: `window.gatewayRequests = [];
      window.__TAURI_INTERNALS__ = { invoke: async (command, params) => {
        window.gatewayRequests.push({ command, params });
        if (window.holdNextGatewayRequest) {
          window.holdNextGatewayRequest = false;
          await new Promise((resolve) => { window.completeGatewayRequest = resolve; });
        }
        if (params.message.type === "open-settings") throw new Error("Could not open Gateway settings. Try again.");
      }};
      ${companionFile("gateway-notice.js")}
      (${companionFile("gateway-switch.js")})(${JSON.stringify({ origin: new URL(suite.server.baseUrl).origin, base: "", snapshot, ...config })});`,
  });
  return () => page.evaluate(() => Reflect.get(window, "gatewayRequests") as GatewayRequest[]);
}

async function ready(page: Page, documentToken: string, currentId = "primary") {
  await page.evaluate(
    ({ token, next }) => {
      window.dispatchEvent(
        new CustomEvent("openclaw:gateway-ready", { detail: { token, snapshot: next } }),
      );
    },
    { token: documentToken, next: { ...snapshot, currentId } },
  );
}

async function installProfiles(page: Page, options?: { id: string; eventDelivery: boolean }) {
  await page.addInitScript((recovery) => {
    const profiles: Array<Record<string, unknown>> = [
      {
        id: "studio",
        name: "Studio",
        hasToken: true,
        hasPassword: false,
        ...(recovery
          ? { transport: "ssh", sshTarget: "operator@unreachable.example.test", remotePort: 18789 }
          : { transport: "direct", url: "https://studio.example.test" }),
      },
    ];
    const calls: Array<Record<string, unknown>> = [];
    let failList = !recovery;
    let publishSaveFailure = recovery?.eventDelivery;
    Reflect.set(window, "profileRequests", calls);
    if (recovery) {
      Reflect.set(window, "replaceGatewayProfile", () => {
        profiles[0] = {
          ...profiles[0],
          id: "external-studio",
          name: "Other studio",
          sshTarget: "operator@elsewhere.example.test",
        };
      });
      Reflect.set(window, "__OPENCLAW_GATEWAY_RECOVERY__", {
        id: recovery.id,
        error: recovery.eventDelivery
          ? ""
          : "SSH connection failed. Check the target and try again.",
      });
    } else {
      Reflect.set(window, "profileCatalog", profiles);
    }
    const invoke = async (command: string, { message }: { message: Record<string, unknown> }) => {
      if (!recovery && command !== "gateway_profile_request") {
        throw new Error(`Unexpected command: ${command}`);
      }
      calls.push(message);
      if (message.action === "list") {
        if (failList) {
          failList = false;
          throw new Error("Could not unlock saved Gateways. Try again.");
        }
        if (publishSaveFailure && profiles[0].id === "updated-studio") {
          publishSaveFailure = false;
          const detail = {
            id: profiles[0].id,
            error: "Updated SSH connection failed. Check the new target.",
          };
          Reflect.set(window, "__OPENCLAW_GATEWAY_RECOVERY__", detail);
          window.dispatchEvent(new CustomEvent("openclaw:gateway-recovery", { detail }));
        }
        const result = { profiles: recovery ? [profiles[0]] : profiles, selectedId: "studio" };
        return recovery ? result : structuredClone(result);
      }
      if (message.action === "save") {
        if (recovery) {
          if (message.id && message.id !== profiles[0].id) {
            throw new Error("That saved Gateway no longer exists.");
          }
          profiles[0] = {
            ...profiles[0],
            id: recovery.eventDelivery ? "updated-studio" : profiles[0].id,
            name: String(message.name),
          };
          return profiles[0];
        }
        const connection = message.connection as Record<string, unknown>;
        const index = profiles.findIndex((entry) => entry.id === message.id);
        const previous = profiles[index];
        const savedCredentials =
          previous &&
          !connection.token &&
          !connection.password &&
          ["transport", "url", "sshTarget", "remotePort"].every(
            (key) => previous[key] === connection[key],
          )
            ? previous
            : undefined;
        const profile = {
          id: message.id ?? "new-profile",
          name: message.name,
          transport: connection.transport,
          url: connection.url,
          sshTarget: connection.sshTarget,
          remotePort: connection.remotePort,
          hasToken: savedCredentials?.hasToken ?? Boolean(connection.token),
          hasPassword: savedCredentials?.hasPassword ?? Boolean(connection.password),
        };
        profiles[index < 0 ? profiles.length : index] = profile;
        return profile;
      }
      if (!recovery && message.action === "remove") {
        profiles.splice(
          profiles.findIndex((entry) => entry.id === message.id),
          1,
        );
      }
      return null;
    };
    Reflect.set(window, "__TAURI__", { core: { invoke } });
  }, options);
}

suite.define(() => {
  it.each(["index.html?mode=stopped", "gateways.html"])(
    "keeps one dismissible native Gateway notice on %s without modal alerts",
    async (file) => {
      await suite.withPage({}, async ({ page }) => {
        const { button } = nativeForm(page);
        const dialogs: string[] = [];
        page.on("dialog", async (dialog) => {
          dialogs.push(dialog.message());
          await dialog.dismiss();
        });
        await serveCompanion(page);
        await page.addInitScript(() => {
          let holdProfiles = false;
          let releaseProfiles: (() => void) | undefined;
          Object.assign(window, {
            holdProfileRefresh: () => {
              holdProfiles = true;
            },
            releaseProfileRefresh: () => releaseProfiles?.(),
            __TAURI__: {
              core: {
                invoke: async (command: string) => {
                  if (command === "discover_gateways") {
                    return [];
                  }
                  if (command === "gateway_profile_request") {
                    if (holdProfiles) {
                      await new Promise<void>((resolve) => {
                        releaseProfiles = resolve;
                      });
                      holdProfiles = false;
                    }
                    return { profiles: [], selectedId: null };
                  }
                  return null;
                },
              },
              event: { listen: async () => () => {} },
            },
          });
        });
        await page.goto(`${suite.server.baseUrl}companion/${file}`);
        const show = (message: string) => showNotice(page, message);
        await show("Credential store is locked.");
        const notice = page.getByRole("alert").filter({ hasText: "Credential store is locked." });
        await notice.waitFor();
        const original = await notice.elementHandle();
        await page.addScriptTag({ content: companionFile("gateway-notice.js") });
        const repeated = "Credential store is locked. <img src=x onerror=alert('unsafe')>";
        await show(repeated);
        await show(repeated);
        expect(await original?.textContent()).toContain(repeated);
        expect(await page.getByRole("alert").count()).toBe(1);
        expect(await page.getByRole("alert").locator("img").count()).toBe(0);
        if (file === "gateways.html") {
          await page.evaluate(() => {
            Reflect.get(window, "holdProfileRefresh")();
            window.dispatchEvent(
              new CustomEvent("openclaw:gateway-profiles-changed", { detail: {} }),
            );
          });
          await expect.poll(() => button("Add Gateway").isDisabled()).toBe(true);
        }
        await page.getByRole("button", { name: "Dismiss Gateway notice" }).click();
        expect(await page.getByRole("alert").count()).toBe(0);
        if (file === "gateways.html") {
          await page.evaluate(() => Reflect.get(window, "releaseProfileRefresh")());
        }
        await show("Retry after unlocking the credential store.");
        expect(await original?.textContent()).toContain("Retry after unlocking");
        expect(await page.getByRole("alert").count()).toBe(1);
        await page.evaluate(() => window.dispatchEvent(new Event("openclaw:gateway-notice-clear")));
        expect(await page.getByRole("alert").count()).toBe(0);
        expect(dialogs).toEqual([]);
      });
    },
  );

  it("uses the shared Gateway menu, queues until native readiness, and replaces the document token", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(suite.server.baseUrl);
      const openMenu = async () => {
        await page.locator(".sidebar-identity-card").click();
        await page.locator(".sidebar-identity-menu").waitFor();
      };
      await openMenu();
      expect(await page.getByRole("menuitemradio", { name: /Studio/ }).count()).toBe(0);
      const requests = await installAdapter(page);
      await page.addInitScript({
        content: `${companionFile("gateway-notice.js")}
          window.dispatchEvent(new CustomEvent("openclaw:gateway-notice", {
            detail: { message: "Credential store was unavailable during startup." },
          }));`,
      });
      await page.reload();
      await waitNotice(page, "unavailable during startup", "alert");
      await openMenu();
      const studio = page.getByRole("menuitemradio", { name: /Studio/ });
      await studio.waitFor();
      await studio.click();
      expect(await requests()).toEqual([]);
      await ready(page, "first-document");
      await expect
        .poll(requests)
        .toEqual([gatewayRequest("first-document", { type: "select", id: "profile:studio" })]);
      await ready(page, "next-document", "profile:studio");
      await openMenu();
      await expect.poll(() => studio.getAttribute("aria-checked")).toBe("true");
      await page
        .getByRole("menuitemradio", { name: /Local Gateway/ })
        .click({ modifiers: ["Control"] });
      await openMenu();
      await page.locator('[data-value="command:gateway-set-primary"]').click();
      await openMenu();
      await page.locator('[data-value="command:gateway-settings"]').click();
      await waitNotice(page, "Could not open Gateway settings", "alert");
      const notice = await page.getByRole("alert").elementHandle();
      await showNotice(page, "Could not unlock saved Gateway credentials.");
      expect(await notice?.textContent()).toContain("Could not unlock saved Gateway credentials.");
      expect(await page.getByRole("alert").count()).toBe(1);
      expect((await requests()).slice(1)).toEqual([
        gatewayRequest("next-document", { type: "open-window", id: "primary" }),
        gatewayRequest("next-document", { type: "set-primary", id: "profile:studio" }),
        gatewayRequest("next-document", { type: "open-settings" }),
      ]);
      await openMenu();
      await page.getByRole("menuitemradio", { name: /Local Gateway/ }).click();
      await expect.poll(() => page.getByRole("alert").count()).toBe(0);
      for (const source of ["native", "invoke"] as const) {
        await page.evaluate(() => {
          Reflect.set(window, "holdNextGatewayRequest", true);
          const { postMessage: postGatewayMessage } = Reflect.get(window, "webkit").messageHandlers
            .openclawGateways;
          Reflect.set(
            window,
            "pendingGatewayRequest",
            postGatewayMessage({ type: "select", id: "primary" }),
          );
        });
        const message =
          source === "native"
            ? "Could not remember the selected Gateway. Unlock the credential store."
            : "Could not open Gateway settings. Try again.";
        if (source === "native") {
          await showNotice(page, message);
        } else {
          await postGateway(page, { type: "open-settings" });
        }
        const warning = page.getByRole("alert").filter({ hasText: message });
        await warning.waitFor();
        await page.evaluate(async () => {
          Reflect.get(window, "completeGatewayRequest")();
          await Reflect.get(window, "pendingGatewayRequest");
        });
        expect(await warning.isVisible()).toBe(true);
        await postGateway(page, { type: "select", id: "primary" });
        expect(await page.getByRole("alert").count()).toBe(0);
      }
    });
  });

  it("does not expose Gateway commands to foreign endpoints, sibling paths, or child frames", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installAdapter(page, { base: "/dashboard" });
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Isolated page</title>",
        }),
      );
      const hasBridge = () =>
        page.evaluate(() =>
          Boolean(Reflect.get(window, "webkit")?.messageHandlers?.openclawGateways),
        );
      await page.goto(`${suite.server.baseUrl}dashboard-other`);
      expect(await hasBridge()).toBe(false);
      await page.goto("http://gateway.example.test/dashboard");
      expect(await hasBridge()).toBe(false);
      await page.goto(`${suite.server.baseUrl}dashboard/chat`);
      expect(await hasBridge()).toBe(true);
      await page.evaluate(() => {
        const iframe = document.createElement("iframe");
        iframe.src = "/dashboard/child";
        document.body.append(iframe);
      });
      await expect.poll(() => page.frames().length).toBe(2);
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
      await frame.waitForLoadState();
      expect(
        await frame.evaluate(() =>
          Boolean(Reflect.get(window, "webkit")?.messageHandlers?.openclawGateways),
        ),
      ).toBe(false);
    });
  });

  it.each([
    { width: 720, height: 520 },
    { width: 390, height: 720 },
  ])(
    "keeps the editor usable at $width × $height and preserves a failed-save draft",
    async (viewport) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const { button, field, heading, text, expectValues } = nativeForm(page);
        const token = field("Gateway token (optional)");
        const password = field("Gateway password (optional)");
        await serveCompanion(page);
        await page.addInitScript(() => {
          Object.assign(window, {
            __TAURI__: {
              core: {
                invoke: async (_command: string, { message }: { message: { action: string } }) => {
                  if (message.action === "save") {
                    throw new Error(
                      "Could not save Gateway. Unlock the credential store and try again.",
                    );
                  }
                  return { profiles: [], selectedId: null };
                },
              },
            },
          });
        });
        await page.goto(`${suite.server.baseUrl}companion/gateways.html`);
        await heading("Manage Gateways").waitFor();
        await button("Add Gateway").click();
        await heading("Add Gateway").waitFor();
        const name = field("Name");
        expect(await name.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await button("Add Gateway").isVisible()).toBe(false);
        expect(await button("Back to Gateways").isVisible()).toBe(true);
        expect(await button("Cancel").count()).toBe(0);
        expect(await field("Authentication").isVisible()).toBe(true);
        expect(await token.isVisible()).toBe(true);
        expect(await field("TLS fingerprint (optional)").isVisible()).toBe(false);
        await name.fill("Workshop");
        await field("Gateway URL").fill("https://workshop.example.test");
        await button("Save Gateway").scrollIntoViewIfNeeded();
        const card = await page.locator(".gateways-panel").boundingBox();
        expect(card).not.toBeNull();
        expect(Math.abs(card!.x - (viewport.width - card!.x - card!.width))).toBeLessThanOrEqual(2);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);

        await field("Connection type").selectOption("ssh");
        await expectControl(field("Gateway URL"), { disabled: true, visible: false });
        await field("SSH target").fill("operator@workshop.example.test");
        expect(await field("TLS fingerprint (optional)").isVisible()).toBe(false);
        await text("Advanced connection settings").click();
        await field("TLS fingerprint (optional)").fill("fixture-fingerprint");
        await token.fill("draft-token");
        await button("Save Gateway").click();
        const error = page.getByRole("alert").filter({ hasText: "Could not save Gateway" });
        await error.waitFor();
        expect(await heading("Add Gateway").isVisible()).toBe(true);
        await expectValues({
          Name: "Workshop",
          "SSH target": "operator@workshop.example.test",
          "TLS fingerprint (optional)": "fixture-fingerprint",
        });
        await expectControl(token, { value: "draft-token", enabled: true });
        expect(await password.isDisabled()).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await button("Back to Gateways").click();
        expect(
          await button("Add Gateway").evaluate((element) => element === document.activeElement),
        ).toBe(true);
        await button("Add Gateway").click();
        await expectValues({ Name: "", "Connection type": "direct" });
        await expectControl(token, { value: "", type: "password" });
        expect(await error.isVisible()).toBe(false);
      });
    },
  );

  it("manages profiles offline without displaying stored credentials and confirms removal", async () => {
    await suite.withPage({ viewport: { width: 980, height: 980 } }, async ({ page }) => {
      const { button, field, heading, expectValues } = nativeForm(page);
      const token = field("Gateway token (optional)");
      const password = field("Gateway password (optional)");
      await serveCompanion(page);
      await installProfiles(page);
      await page.goto(`${suite.server.baseUrl}companion/gateways.html`);
      await waitNotice(page, "Could not unlock saved Gateways", "alert");
      await page.getByRole("button", { name: "Try again" }).click();
      await button("Edit Studio").click();
      expect(await page.getByRole("heading", { name: "Manage Gateways" }).isVisible()).toBe(false);
      expect(await page.getByRole("list", { name: "Saved Gateways" }).isVisible()).toBe(false);
      expect(await field("Name").evaluate((element) => element === document.activeElement)).toBe(
        true,
      );
      await expectValues({
        Authentication: "token",
        "Gateway token (optional)": "",
        "Gateway password (optional)": "",
      });
      expect(await token.isVisible()).toBe(true);
      await expectControl(password, { visible: false, disabled: true });
      await page.getByText(/Saved credentials stay hidden/).waitFor();
      await token.fill("unsaved-token");
      for (const colorScheme of ["dark", "light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await expect
          .poll(() =>
            page.evaluate(() => ({
              background: getComputedStyle(document.documentElement).backgroundColor,
              field: getComputedStyle(document.querySelector("#gateway-token")!).backgroundColor,
            })),
          )
          .toEqual(
            colorScheme === "light"
              ? { background: "rgb(250, 249, 247)", field: "rgb(255, 255, 255)" }
              : { background: "rgb(14, 16, 21)", field: "rgb(22, 25, 32)" },
          );
        expect(await field("Name").inputValue()).toBe("Studio");
        await expectControl(token, { value: "unsaved-token", type: "password" });
      }
      await button("Show credential").click();
      expect(await token.getAttribute("type")).toBe("text");
      await button("Back to Gateways").click();
      expect(await page.locator("#gateway-editor").isVisible()).toBe(false);
      expect(
        await button("Add Gateway").evaluate((element) => element === document.activeElement),
      ).toBe(true);
      await button("Edit Studio").click();
      await expectControl(token, { value: "", type: "password" });
      expect(await button("Show credential").isVisible()).toBe(true);
      await field("Name").fill("  ");
      await button("Save Gateway").click();
      expect(
        await field("Name").evaluate((element: HTMLInputElement) => element.validity.valid),
      ).toBe(false);
      await button("Back to Gateways").click();
      await button("Edit Studio").click();
      await button("Save Gateway").click();
      await waitNotice(page, "Saved Studio", "status");
      await button("Edit Studio").click();
      await field("Name").fill("Home studio");
      await button("Save Gateway").click();
      await button("Open Home studio").click();
      await waitNotice(page, "Opened Home studio", "status");
      const requests = () => profileRequests(page);
      expect(
        (await requests()).find(
          (message) => message.action === "save" && message.name === "Home studio",
        ),
      ).toEqual({
        action: "save",
        id: "studio",
        name: "Home studio",
        connection: {
          transport: "direct",
          url: "https://studio.example.test",
          token: null,
          password: null,
        },
      });
      await button("Edit Home studio").click();
      await token.fill("fixture-token");
      await button("Show credential").click();
      await field("Authentication").selectOption("password");
      await expectControl(token, { value: "", visible: false, disabled: true });
      await expectControl(password, { visible: true, enabled: true, type: "password" });
      await password.fill("fixture-password");
      await button("Show credential").click();
      expect(await password.getAttribute("type")).toBe("text");
      await button("Hide credential").click();
      expect(await password.getAttribute("type")).toBe("password");
      await field("Authentication").selectOption("token");
      expect(await password.inputValue()).toBe("");
      await token.fill("replacement-token");
      await button("Save Gateway").click();
      await waitNotice(page, "Saved Home studio", "status");
      expect(await lastRequest(page, "save")).toMatchObject({
        id: "studio",
        connection: { token: "replacement-token", password: null },
      });
      await button("Edit Home studio").click();
      await expectValues({
        "Gateway token (optional)": "",
        "Gateway password (optional)": "",
      });
      expect(await token.getAttribute("type")).toBe("password");
      await field("Authentication").selectOption("password");
      await button("Save Gateway").click();
      await waitNotice(page, "Saved Home studio", "status");
      expect(await lastRequest(page, "save")).toMatchObject({
        connection: { token: null, password: null },
      });
      await button("Add Gateway").click();
      await field("Name").fill("Workshop");
      await field("Connection type").selectOption("ssh");
      await field("SSH target").fill("operator@workshop.example.test");
      await field("Gateway port").fill("19789");
      await field("Authentication").selectOption("password");
      await password.fill("fixture-password");
      await button("Save Gateway").click();
      await button("Edit Workshop").waitFor();
      expect(await lastRequest(page, "save")).toEqual({
        action: "save",
        name: "Workshop",
        connection: {
          transport: "ssh",
          sshTarget: "operator@workshop.example.test",
          remotePort: 19789,
          tlsFingerprint: null,
          token: null,
          password: "fixture-password",
        },
      });
      await button("Edit Workshop").click();
      expect(await field("Authentication").inputValue()).toBe("password");
      await expectControl(password, { visible: true, value: "" });
      await button("Back to Gateways").click();
      await button("Remove Workshop").click();
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      expect(await requestsOf(page, "remove")).toHaveLength(0);
      await button("Remove Workshop").click();
      await button("Remove Gateway").click();
      await expect.poll(() => button("Edit Workshop").count()).toBe(0);
      expect(await requestsOf(page, "remove")).toEqual([{ action: "remove", id: "new-profile" }]);
      await updateProfiles(page, [{ profile: { name: "Renamed studio" } }]);
      await button("Open Renamed studio").waitFor();
      await button("Remove Renamed studio").click();
      await page.getByRole("dialog").waitFor();
      await updateProfiles(page, [
        {
          profile: { id: "relocated-studio", name: "Relocated studio" },
          detail: { previousId: "studio", id: "relocated-studio" },
        },
      ]);
      await button("Open Relocated studio").click();
      expect(await page.getByRole("dialog").isVisible()).toBe(false);
      expect(await requestsOf(page, "remove")).toHaveLength(1);
      expect((await lastRequest(page, "open"))?.id).toBe("relocated-studio");
      await button("Edit Relocated studio").click();
      await field("Name").fill("My draft");
      await updateProfiles(page, [
        {
          profile: { id: "intermediate-studio" },
          detail: { previousId: "relocated-studio", id: "intermediate-studio" },
        },
        {
          profile: { id: "moved-studio", name: "Moved studio", url: "https://moved.example.test" },
          detail: { previousId: "intermediate-studio", id: "moved-studio" },
        },
      ]);
      expect(await heading("Edit Gateway").isVisible()).toBe(true);
      expect(await page.getByRole("list", { name: "Saved Gateways" }).isVisible()).toBe(false);
      await expectValues({ Name: "My draft", "Gateway URL": "https://studio.example.test" });
      await button("Save Gateway").click();
      await waitNotice(page, "Saved My draft", "status");
      expect((await lastRequest(page, "save"))?.id).toBe("moved-studio");
      await button("Edit My draft").click();
      await token.fill("draft-token");
      await page.evaluate(() => {
        (Reflect.get(window, "profileCatalog") as Array<Record<string, unknown>>).splice(0);
        window.dispatchEvent(
          new CustomEvent("openclaw:gateway-profiles-changed", {
            detail: { previousId: "moved-studio" },
          }),
        );
      });
      await waitNotice(page, "removed", "status");
      await heading("Add Gateway").waitFor();
      await expectValues({ Name: "My draft", "Gateway token (optional)": "draft-token" });
      expect(await button("Open My draft").count()).toBe(0);
      await button("Save Gateway").click();
      await button("Open My draft").waitFor();
      expect(await lastRequest(page, "save")).toMatchObject({
        name: "My draft",
        connection: { token: "draft-token" },
      });
      expect((await lastRequest(page, "save"))?.id).toBeUndefined();
    });
  });

  it.each([
    { recoveryId: "studio", delivery: "initial" },
    { recoveryId: "removed", delivery: "initial" },
    { recoveryId: "studio", delivery: "event" },
  ])(
    "offers $delivery recovery for failed SSH profile $recoveryId without replaying its error after save",
    async ({ recoveryId, delivery }) => {
      await suite.withPage({}, async ({ page }) => {
        const { button, field, heading, expectValues } = nativeForm(page);
        await serveCompanion(page);
        await installProfiles(page, { id: recoveryId, eventDelivery: delivery === "event" });
        await page.goto(`${suite.server.baseUrl}companion/gateways.html`);
        if (delivery !== "event") {
          await waitNotice(page, "SSH connection failed", "alert");
        }
        if (recoveryId === "studio") {
          await heading("Edit Gateway").waitFor();
          expect(await field("SSH target").inputValue()).toBe("operator@unreachable.example.test");
        } else {
          expect(await page.locator("#gateway-editor").isVisible()).toBe(false);
          await button("Open Studio").click({ trial: true });
          await button("Add Gateway").click();
          await field("Connection type").selectOption("ssh");
        }
        await expectValues({
          "Gateway token (optional)": "",
          "Gateway password (optional)": "",
        });
        await field("Name").fill("Recovered studio");
        await field("SSH target").fill("operator@studio.example.test");
        if (delivery === "event") {
          expect(await page.locator("#gateway-error").getAttribute("hidden")).not.toBeNull();
          await field("Gateway token (optional)").fill("unsaved-token");
          await page.evaluate(() => {
            Reflect.get(window, "replaceGatewayProfile")();
            const detail = {
              id: "external-studio",
              error: "SSH connection failed. Check the target and try again.",
            };
            Reflect.set(window, "__OPENCLAW_GATEWAY_RECOVERY__", detail);
            window.dispatchEvent(new CustomEvent("openclaw:gateway-recovery", { detail }));
          });
          await waitNotice(page, "SSH connection failed", "alert");
          expect(await heading("Edit Gateway").isVisible()).toBe(true);
          expect(await page.getByRole("list", { name: "Saved Gateways" }).isVisible()).toBe(false);
          await expectValues({
            Name: "Recovered studio",
            "SSH target": "operator@studio.example.test",
            "Gateway token (optional)": "unsaved-token",
          });
          await field("Gateway token (optional)").fill("");
        }
        await button("Save Gateway").click();
        if (delivery === "event") {
          await waitNotice(page, "Updated SSH connection failed", "alert");
          await heading("Edit Gateway").waitFor();
          expect(await field("Name").inputValue()).toBe("Recovered studio");
          await field("Name").fill("Ready studio");
          await button("Save Gateway").click();
          await waitNotice(page, "Saved Ready studio", "status");
          const lastSave = (await profileRequests(page)).findLast(
            (message) => message.action === "save",
          );
          expect(lastSave?.id).toBe("updated-studio");
        } else {
          await waitNotice(page, "Saved Recovered studio", "status");
        }
        expect(await page.getByRole("alert").isVisible()).toBe(false);
        expect(await page.locator("#gateway-editor").isVisible()).toBe(false);
        const saved = (await profileRequests(page)).find((message) => message.action === "save");
        expect(saved).toEqual({
          action: "save",
          ...(recoveryId === "studio"
            ? { id: delivery === "event" ? "external-studio" : "studio" }
            : {}),
          name: "Recovered studio",
          connection: {
            transport: "ssh",
            sshTarget: "operator@studio.example.test",
            remotePort: 18789,
            tlsFingerprint: null,
            token: null,
            password: null,
          },
        });
      });
    },
  );
});
