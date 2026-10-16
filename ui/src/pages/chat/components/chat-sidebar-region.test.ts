/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import { createControlUiPluginHost } from "../../../plugins/control-ui-host.ts";
import "../../../components/resizable-divider.ts";
import {
  ControlUiPluginRuntime,
  type ControlUiPluginOwner,
} from "../../../plugins/control-ui-runtime.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import { createInitializationContext } from "../chat-pane.test-support.ts";
import { createPageState } from "../chat-state-page.ts";
import { createChatProps } from "../chat-view.test-helpers.ts";
import {
  activatePanel,
  openSlot,
  closeSlot,
  promoteSidebarPanel,
  setSidebarOpen,
  setSidebarDock,
  setSidebarExpanded,
  SIDEBAR_GEOMETRY_COMMIT_EVENT,
  type SidebarLayout,
} from "../sidebar-layout.ts";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";
import "./chat-sidebar-region.runtime.tsx";

type Region = HTMLElementTagNameMap["openclaw-chat-sidebar-region"];

const regions: Region[] = [];

function element(markup: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const child = template.content.firstElementChild;
  if (!(child instanceof HTMLElement)) {
    throw new Error("Expected a fixture element");
  }
  return child;
}

async function createRegion(
  layout: SidebarLayout = openSlot({ columns: [] }, "detail"),
  definitions?: SidebarPanelDefinition[],
) {
  const shell = document.createElement("div");
  shell.className = "sidebar-region";
  const region = document.createElement("openclaw-chat-sidebar-region");
  region.panelIdPrefix = `sidebar-region-fixture-${regions.length}`;
  region.layout = layout;
  const content: Partial<Record<SidebarPanelDefinition["slot"], HTMLElement>> = {
    detail: element('<div data-panel="detail">Detail panel</div>'),
    terminal: element('<div data-panel="terminal">Terminal panel</div>'),
    workspace: element('<div data-panel="workspace">Workspace panel</div>'),
  };
  region.panelDefinitions =
    definitions ??
    sidebarPanelDefinitions().map((definition) =>
      Object.assign(definition, {
        available: ["detail", "terminal", "workspace", "companion", "dashboard"].includes(
          definition.slot,
        ),
        content: content[definition.slot] ?? null,
      }),
    );
  region.callbacks = {
    activatePanel: vi.fn(),
    togglePanelExpanded: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    reorderPanel: vi.fn(),
    resizePanel: vi.fn(),
    setOpen: vi.fn(),
  };
  region.availableWidth = 1_200;
  const primary = document.createElement("div");
  primary.className = "sidebar-region__primary";
  primary.dataset.region = "main";
  primary.innerHTML = "<main data-primary>Primary</main>";
  const rightRuntime = document.createElement("div");
  rightRuntime.className = "sidebar-region__right-runtime";
  shell.append(region, primary, rightRuntime);
  document.body.append(shell);
  regions.push(region);
  await region.updateComplete;
  return region;
}

function root(region: Region): HTMLElement {
  return region.parentElement!;
}

function query<T extends Element = HTMLElement>(region: Region, selector: string) {
  return root(region).querySelector<T>(selector);
}

async function updateRegion(region: Region, changes: Partial<Region>) {
  Object.assign(region, changes);
  await region.updateComplete;
}

function nativeClose(detail?: { browserScope: string }) {
  const event = new CustomEvent("openclaw:native-close-focused-panel", {
    cancelable: true,
    detail,
  });
  window.dispatchEvent(event);
  return event;
}

function pointAt(target: Element) {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
}

afterEach(() => {
  for (const region of regions.splice(0)) {
    region.parentElement?.remove();
  }
});

describe("chat sidebar region", () => {
  it("restores an expanded panel from its active tab with pointer or keyboard", async () => {
    const region = await createRegion({
      ...openSlot({ columns: [] }, "workspace"),
      expanded: true,
      expandedSide: true,
    });
    const tab = query<HTMLElement>(region, '.tabstrip-tab[data-tab-value="workspace"]')!;
    tab.click();
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(region.callbacks?.togglePanelExpanded).toHaveBeenCalledTimes(3);
    expect(region.callbacks?.togglePanelExpanded).toHaveBeenLastCalledWith("workspace");

    region.sideFocusLocked = true;
    await region.updateComplete;
    tab.click();
    expect(region.callbacks?.togglePanelExpanded).toHaveBeenCalledTimes(3);
  });

  it("updates the conversation tab identity without relabeling other panels or their controls", async () => {
    const layout = openSlot(openSlot({ columns: [] }, "dashboard"), "workspace");
    const dashboard = layout.columns[0]!.panels.find((panel) => panel.slot === "dashboard")!;
    const region = await createRegion(promoteSidebarPanel(layout, dashboard.id));
    const label = () =>
      query(region, '.tabstrip-tab[data-tab-value="conversation"] .tabstrip-tab__label');
    expect(label()?.textContent).toBe("Chat");

    await updateRegion(region, {
      conversationTab: {
        label: "Research assistant",
        avatar: { id: "research-assistant", textAvatar: "🦉" },
      },
    });
    expect(label()?.textContent).toBe("Research assistant");
    const icon = root(region).querySelector(
      '.tabstrip-tab[data-tab-value="conversation"] .identity-avatar--agent',
    );
    expect(icon).not.toBeNull();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(icon!.closest(".tabstrip-tab__icon")!, { childList: true, subtree: true });
    region.layout = { ...region.layout, columns: [...region.layout.columns] };
    await region.updateComplete;
    mutations.push(...observer.takeRecords());
    observer.disconnect();
    expect(mutations).toHaveLength(0);
    expect(
      root(region).querySelector(
        '.tabstrip-tab[data-tab-value="conversation"] .identity-avatar--agent',
      ),
    ).toBe(icon);
    expect(
      root(region)
        .querySelector(
          '.tabstrip-tab[data-tab-value="conversation"] .identity-avatar--agent .identity-avatar__text',
        )
        ?.getAttribute("data-avatar"),
    ).toBe("🦉");
    expect(root(region).querySelector('button[aria-label="Close Chat"]')).not.toBeNull();
    expect(
      [...root(region).querySelectorAll(".tabstrip-tab__label")].map((tab) => tab.textContent),
    ).toContain("Files");

    Object.assign(region, {
      conversationTab: { label: "", avatar: { id: "research-assistant", textAvatar: "🦉" } },
    });
    await region.updateComplete;
    expect(label()?.textContent).toBe("Chat");
    expect(
      query(region, '.tabstrip-tab[data-tab-value="conversation"]')?.querySelector(
        "openclaw-tooltip",
      )?.content,
    ).toBe("Chat");

    await updateRegion(region, {
      conversationTab: {
        label: "Planning assistant",
        avatar: { id: "planning-assistant", textAvatar: "🦊" },
      },
    });
    expect(label()?.textContent).toBe("Planning assistant");
    expect(
      root(region)
        .querySelector(".identity-avatar--agent .identity-avatar__text")
        ?.getAttribute("data-avatar"),
    ).toBe("🦊");
    region.conversationTab = undefined;
    await region.updateComplete;
    expect(label()?.textContent).toBe("Chat");
  });

  it("coalesces committed geometry and retires disconnected measurements", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const region = await createRegion();
    await updateRegion(region, { narrow: true });
    const shell = root(region);
    const primary = shell.querySelector<HTMLElement>(".sidebar-region__primary")!;
    const panel = shell.querySelector<HTMLElement>(".side-panel__panel")!;
    let mainWidth = 800;
    let sideWidth = 400;
    const measure = vi
      .spyOn(primary, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(0, 0, mainWidth, 600));
    vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, sideWidth, 600),
    );
    const commits: boolean[] = [];
    shell.addEventListener(SIDEBAR_GEOMETRY_COMMIT_EVENT, (event) => {
      commits.push((event as CustomEvent<{ widthChanged: boolean }>).detail.widthChanged);
    });
    vi.advanceTimersToNextFrame();
    measure.mockClear();
    commits.length = 0;

    for (let index = 0; index < 4; index++) {
      await updateRegion(region, { layout: { ...region.layout } });
    }
    expect(measure).not.toHaveBeenCalled();
    expect(commits).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(commits).toEqual([false]);

    // Swapping content can keep the total width while changing each transcript.
    mainWidth = 400;
    sideWidth = 800;
    await updateRegion(region, { layout: { ...region.layout } });
    vi.advanceTimersToNextFrame();
    expect(commits).toEqual([false, true]);

    measure.mockClear();
    await updateRegion(region, { layout: { ...region.layout } });
    shell.remove();
    vi.advanceTimersToNextFrame();
    expect(measure).not.toHaveBeenCalled();
  });

  it("claims native Close for the focused side tab and preserves its neighbor", async () => {
    const region = await createRegion(
      openSlot(openSlot({ columns: [] }, "workspace"), "companion"),
    );
    region.panelDefinitions = region.panelDefinitions.map((definition) =>
      Object.assign({}, definition, {
        content:
          definition.slot === "companion"
            ? element('<textarea aria-label="Side chat"></textarea>')
            : null,
      }),
    );
    region.callbacks!.closeSlot = (slot) => {
      region.layout = closeSlot(region.layout, slot);
    };
    await region.updateComplete;
    query(region, "textarea")!.focus();

    const command = nativeClose();
    expect(command.defaultPrevented).toBe(true);
    await region.updateComplete;
    expect(region.layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["workspace"]);
    expect(region.layout.open).toBe(true);

    const nextCommand = nativeClose();
    expect(nextCommand.defaultPrevented).toBe(true);
    expect(region.layout.open).toBe(false);
  });

  it("yields native Close after pointer focus moves from Side chat to main or outside", async () => {
    const region = await createRegion();
    const side = query<HTMLElement>(region, '[data-panel-slot="detail"]')!;
    pointAt(side);
    const main = query<HTMLElement>(region, "[data-primary]")!;
    pointAt(main);
    const mainCommand = nativeClose();
    expect(mainCommand.defaultPrevented).toBe(false);
    pointAt(side);
    pointAt(document.body);
    const outsideCommand = nativeClose();
    expect(outsideCommand.defaultPrevented).toBe(false);
    expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();
  });

  it("uses current main/side roles and closes through the conversation owner", async () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "conversation"), "detail"),
      "detail",
    );
    const region = await createRegion(layout);
    const main = query<HTMLElement>(region, '[data-panel-slot="detail"]')!;
    pointAt(main);
    const mainCommand = nativeClose();
    expect(mainCommand.defaultPrevented).toBe(false);
    const conversation = query<HTMLElement>(region, ".sidebar-region__primary")!;
    conversation.dataset.region = "side";
    pointAt(conversation);
    const command = nativeClose();
    expect(command.defaultPrevented).toBe(true);
    expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("conversation");
  });

  it("routes native Browser focus by its presentation scope, not stale page focus", async () => {
    const other = await createRegion();
    const region = await createRegion(openSlot({ columns: [] }, "browser"));
    region.panelDefinitions = region.panelDefinitions.map((definition) =>
      Object.assign({}, definition, {
        content:
          definition.slot === "browser"
            ? element('<div data-native-browser-scope="native-owner"></div>')
            : null,
      }),
    );
    await region.updateComplete;
    pointAt(query(other, "[data-panel-slot]")!);
    const command = nativeClose({ browserScope: "native-owner" });
    expect(command.defaultPrevented).toBe(true);
    expect(region.callbacks!.closeSlot).toHaveBeenCalledExactlyOnceWith("browser");
    expect(other.callbacks!.closeSlot).not.toHaveBeenCalled();
  });

  it.each(["hidden", "minimized", "disconnected"] as const)(
    "does not claim native Close from a %s retained panel",
    async (state) => {
      const region = await createRegion();
      pointAt(query(region, "[data-panel-slot]")!);
      if (state === "hidden") {
        root(region).hidden = true;
      }
      if (state === "minimized") {
        region.layout = setSidebarOpen(region.layout, false);
      }
      if (state === "disconnected") {
        root(region).remove();
      }
      const command = nativeClose();
      expect(command.defaultPrevented).toBe(false);
      expect(region.callbacks!.closeSlot).not.toHaveBeenCalled();
    },
  );

  it("retains unavailable plugin tabs and recovers their registration", async () => {
    const slot = "plugin:fixture/notes";
    const layout = openSlot(openSlot({ columns: [] }, "workspace"), slot);
    const saved = structuredClone(layout);
    const context = createInitializationContext();
    const state = createPageState(
      context,
      { afterCommit: () => () => {}, invalidate: vi.fn() },
      document.createElement("div"),
    );
    state.sessionKey = "agent:main:main";
    state.sidebarLayout = layout;
    const runtime = new ControlUiPluginRuntime(() => context);
    const owner: Omit<ControlUiPluginOwner, "host"> = {
      descriptor: {
        pluginId: "fixture",
        name: "Fixture",
        revision: "one",
        entryUrl: "/__openclaw__/plugins/control-ui/fixture/one/index.js",
        styles: [],
      },
      client: new GatewayBrowserClient({ url: "ws://fixture.invalid" }),
      abort: new AbortController(),
      disposers: new Set(),
      contributions: {
        pages: new Map(),
        navigation: new Map(),
        panels: new Map(),
        actions: new Map(),
        replacements: new Map(),
        accessories: new Map(),
        widgets: new Map(),
      },
      selections: new Map(),
    };
    onTestFinished(() => {
      owner.abort.abort();
      owner.client.stop();
      runtime.dispose();
    });
    const entry: NonNullable<
      Parameters<typeof sidebarPanelDefinitions>[0]
    >["pluginPanels"][number] = {
      key: "fixture/notes",
      pluginId: "fixture",
      value: { id: "notes", label: "Fixture notes", mount: () => undefined },
      host: createControlUiPluginHost(() => context, runtime, owner),
      signal: owner.abort.signal,
    };
    const params: NonNullable<Parameters<typeof sidebarPanelDefinitions>[0]> = {
      state,
      paneId: "fixture",
      panePresentationId: "fixture-main",
      subagentsInputRegion: "page",
      subagentsPresented: false,
      subagentsAvailable: false,
      onSubagentSessionSelect: vi.fn(),
      themeMode: "dark",
      agentId: "main",
      browserPresented: false,
      browserTabsInHeader: true,
      terminalTabsInHeader: true,
      companionPresented: false,
      companionFocusRequest: undefined,
      browserRefreshOnPresentation: false,
      desktopPresented: false,
      desktopRefreshOnPresentation: false,
      desktopAvailable: false,
      desktopSource: null,
      desktopFocusHref: "",
      onDesktopFocusTargetChange: vi.fn(),
      dashboard: null,
      workspace: undefined,
      detail: { chat: createChatProps(), host: state, requestUpdate: vi.fn() },
      digest: null,
      activeRunId: null,
      pullRequests: [],
      companion: {
        turns: [],
        loading: false,
        draft: "",
      },
      onCompanionSubmit: vi.fn(),
      onCompanionDraftChange: vi.fn(),
      connected: false,
      onClearCompanion: vi.fn(),
      discussion: null,
      discussionAvailable: false,
      discussionOpenUrl: null,
      discussionSourceGeneration: 0,
      pluginPanels: [],
      isPluginPanelPresented: () => true,
    };
    const workspace = element('<div data-panel="workspace">Workspace panel</div>');
    const definitions = () =>
      sidebarPanelDefinitions(params).map((definition) =>
        definition.slot === "workspace"
          ? Object.assign(definition, { view: undefined, content: workspace })
          : definition,
      );
    const region = await createRegion(layout, definitions());
    params.pluginPanels = [];
    const refresh = async () => {
      region.panelDefinitions = definitions();
      await region.updateComplete;
    };
    await refresh();

    const unavailable = query(region, `[data-panel-slot="${slot}"] openclaw-panel-empty-state`);
    expect(unavailable?.textContent).toContain("The plugin that owns this tab is not active");
    expect(region.panelDefinitions.find((definition) => definition.slot === slot)?.available).toBe(
      false,
    );
    expect(region.layout).toEqual(saved);
    query<HTMLButtonElement>(region, 'button[aria-label="Close fixture/notes"]')?.click();
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith(slot);

    query<HTMLButtonElement>(region, '.tabstrip-tab[data-tab-value="workspace"]')?.click();
    expect(region.callbacks?.activatePanel).toHaveBeenCalledWith("workspace");
    await updateRegion(region, { layout: activatePanel(region.layout, "workspace") });
    expect(query(region, '[data-panel-slot="workspace"]')?.hasAttribute("hidden")).toBe(false);
    expect(query(region, '[data-panel="workspace"]')?.textContent).toBe("Workspace panel");

    params.pluginPanels = [entry];
    await refresh();
    expect(region.panelDefinitions.find((definition) => definition.slot === slot)?.available).toBe(
      true,
    );
    expect(query(region, `[data-panel-slot="${slot}"] openclaw-plugin-view`)).not.toBeNull();
    expect(query(region, 'button[aria-label="Close Fixture notes"]')).not.toBeNull();
    expect(region.layout.columns[0]?.panels).toEqual(saved.columns[0]?.panels);
  });

  it.each([
    { slot: "browser", eventType: "openclaw:browser-toggle", detail: { open: true, newTab: true } },
  ] as const)(
    "keeps $slot available in the plus menu to create another hosted tab",
    async ({ slot, eventType, detail }) => {
      const handleToggleRequest = vi.fn();
      const region = await createRegion(openSlot({ columns: [] }, slot));
      region.panelDefinitions = region.panelDefinitions.map((definition) =>
        Object.assign({}, definition, {
          available: definition.slot === slot,
          content:
            definition.slot === slot
              ? Object.assign(element("<div>Panel content</div>"), { handleToggleRequest })
              : null,
        }),
      );
      await region.updateComplete;
      query<HTMLButtonElement>(region, ".side-panel-type-menu__trigger")!.click();
      await waitForSolid(() =>
        expect(query(region, '[role="menu"]')?.matches(":popover-open")).toBe(true),
      );
      const menuItem = Array.from(
        root(region).querySelectorAll<HTMLButtonElement>(".side-panel-type-menu__item"),
      ).find((item) => Reflect.get(item, "value") === slot);

      expect(menuItem).toBeDefined();
      menuItem!.click();

      await waitForSolid(() => expect(region.callbacks?.openSlot).toHaveBeenCalledWith(slot));
      expect(region.callbacks?.openSlot).toHaveBeenCalledBefore(handleToggleRequest);
      expect(handleToggleRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: eventType, detail }),
      );
    },
  );

  it("opens into a type selector instead of restoring a previous tab", async () => {
    const region = await createRegion(setSidebarOpen({ columns: [], expanded: false }, true));
    const selector = query(region, ".side-panel-empty--selector");

    expect(selector?.querySelector(".side-panel-empty__title")).toBeNull();
    expect(selector?.querySelector(".side-panel-empty__description")).toBeNull();
    expect(selector?.querySelector(":scope > .side-panel-empty__icon")).toBeNull();
    expect(
      Array.from(selector?.querySelectorAll(".side-panel-empty__type") ?? [], (item) =>
        item.textContent?.replace(/\s+/gu, " ").trim(),
      ),
    ).toEqual([
      "Review Ctrl+Alt+Shift+E",
      "Terminal Ctrl+`",
      "Files Ctrl+Shift+B",
      "Side chat Ctrl+Shift+S",
      "Dashboard Ctrl+Alt+Shift+G",
    ]);
    query<HTMLButtonElement>(region, ".side-panel-empty__type")?.click();
    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("detail");

    const dashboard = Array.from(
      root(region).querySelectorAll<HTMLButtonElement>(".side-panel-empty__type"),
    ).find(
      (button) =>
        button.querySelector(".side-panel-type-option__label")?.textContent === "Dashboard",
    );
    dashboard?.click();
    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("dashboard");
  });

  it("offers every chat-side content owner through the shared type menu", async () => {
    const region = await createRegion();
    region.panelDefinitions = region.panelDefinitions.map((definition) =>
      Object.assign({}, definition, {
        available: [
          "detail",
          "terminal",
          "browser",
          "workspace",
          "companion",
          "desktop",
          "discussion",
          "dashboard",
        ].includes(definition.slot),
      }),
    );
    await region.updateComplete;

    expect(query(region, ".side-panel-type-menu__trigger")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    query<HTMLButtonElement>(region, ".side-panel-type-menu__trigger")!.click();
    await waitForSolid(() =>
      expect(query(region, '[role="menu"]')?.matches(":popover-open")).toBe(true),
    );
    expect(
      Array.from(root(region).querySelectorAll(".side-panel-type-menu__item"), (item) =>
        item.textContent?.replace(/\s+/gu, " ").trim(),
      ),
    ).toEqual([
      "Terminal Ctrl+`",
      "Browser Ctrl+Alt+Shift+U",
      "Files Ctrl+Shift+B",
      "Side chat Ctrl+Shift+S",
      "Desktop Ctrl+Alt+Shift+D",
      "Discussion Ctrl+Alt+Shift+J",
      "Dashboard Ctrl+Alt+Shift+G",
    ]);

    const browserMenuItem = Array.from(
      root(region).querySelectorAll<HTMLElement>(".side-panel-type-menu__item"),
    ).find((item) => Reflect.get(item, "value") === "browser");
    expect(browserMenuItem?.querySelector('path[d="M2 12h20"]')).not.toBeNull();

    await updateRegion(region, { layout: openSlot({ columns: [] }, "browser") });
    expect(query(region, '.tabstrip-tab__icon path[d="M2 12h20"]')).not.toBeNull();

    await updateRegion(region, { layout: { columns: [], open: true } });
    const browserEmptyItem = Array.from(
      root(region).querySelectorAll<HTMLElement>(".side-panel-empty__type"),
    ).find(
      (item) => item.querySelector(".side-panel-type-option__label")?.textContent === "Browser",
    );
    expect(browserEmptyItem?.querySelector('path[d="M2 12h20"]')).not.toBeNull();
  });

  it("keeps side tab dismissal separate from task toolbar actions", async () => {
    const region = await createRegion();
    expect(query(region, '[data-region-header="side"] .rail-header__actions')).toBeNull();
    query<HTMLButtonElement>(region, 'button[aria-label="Close Review"]')!.click();
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("detail");
    await updateRegion(region, {
      layout: setSidebarExpanded(promoteSidebarPanel(region.layout, "detail"), true),
    });
    expect(query(region, '[data-region-header="main"]')).toBeNull();
    expect(
      Array.from(root(region).querySelectorAll(".tabstrip-tab__label"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Chat"]);
  });

  it("docks and resizes the same panel across left, right, and bottom layouts", async () => {
    const region = await createRegion(
      setSidebarDock(openSlot({ columns: [] }, "detail"), "bottom"),
    );
    const primary = query<HTMLElement>(region, ".sidebar-region__primary")!;
    const panel = query<HTMLElement>(region, '[data-region="side"]:not([hidden])')!;
    const divider = query<HTMLElement & { orientation: string }>(region, "resizable-divider")!;
    primary.getBoundingClientRect = () => ({ height: 440 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ height: 360 }) as DOMRect;
    root(region).getBoundingClientRect = () => ({ height: 800 }) as DOMRect;

    expect(divider.orientation).toBe("horizontal");
    divider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.5 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenCalledWith(region.layout.columns[0]!.id, 400);
    await updateRegion(region, { layout: setSidebarDock(region.layout, "left") });
    primary.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ width: 400 }) as DOMRect;
    const leftDivider = query<HTMLElement & { orientation: string }>(region, "resizable-divider")!;
    expect(leftDivider.orientation).toBe("vertical");
    leftDivider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.25 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenLastCalledWith(
      region.layout.columns[0]!.id,
      300,
    );
  });

  it("retains hidden side content and visible main content when the side panel is minimized", async () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "detail"), "terminal"),
      "detail",
    );
    const region = await createRegion(setSidebarOpen(layout, false));
    expect(query(region, '[data-panel-slot="terminal"]')?.hasAttribute("hidden")).toBe(true);
    expect(query(region, '[data-panel="terminal"]')).not.toBeNull();
    expect(query(region, '[data-panel-slot="detail"]')?.hasAttribute("hidden")).toBe(false);
    expect(query(region, "resizable-divider")).toBeNull();
    expect(query(region, '[data-region-header="main"]')).toBeNull();
    expect(query(region, "[data-primary]")).not.toBeNull();
  });

  it("retains app input and terminal content while minimizing until their tabs close", async () => {
    const region = await createRegion(
      setSidebarOpen(openSlot(openSlot({ columns: [] }, "terminal"), "dashboard"), false),
    );
    region.panelDefinitions = region.panelDefinitions.map((definition) =>
      definition.slot === "dashboard"
        ? Object.assign({}, definition, {
            content: element('<input aria-label="Unsaved app input" />'),
          })
        : definition,
    );
    await region.updateComplete;
    expect(query(region, '[data-panel-slot="dashboard"]')).toBeNull();
    await updateRegion(region, { layout: setSidebarOpen(region.layout, true) });
    const input = query<HTMLInputElement>(region, "input")!;
    input.value = "Unsaved note";
    const terminal = query(region, '[data-panel="terminal"]')!;

    await updateRegion(region, { layout: setSidebarOpen(region.layout, false) });
    const panel = query<HTMLElement>(region, '[data-panel-slot="dashboard"]')!;
    expect(panel.hidden).toBe(true);
    expect(query(region, "resizable-divider")).toBeNull();
    expect(input.isConnected).toBe(true);
    expect(terminal.isConnected).toBe(true);
    expect(query<HTMLElement>(region, '[data-panel-slot="terminal"]')?.hidden).toBe(true);

    await updateRegion(region, { layout: setSidebarOpen(region.layout, true) });
    expect(query(region, "input")).toBe(input);
    expect(input.value).toBe("Unsaved note");
    expect(panel.hidden).toBe(false);
    expect(query(region, '[data-panel="terminal"]')).toBe(terminal);

    await updateRegion(region, { layout: closeSlot(region.layout, "dashboard") });
    expect(input.isConnected).toBe(false);
    expect(query(region, '[data-panel="terminal"]')).toBe(terminal);
    expect(query<HTMLElement>(region, '[data-panel-slot="terminal"]')?.hidden).toBe(false);
  });
});
