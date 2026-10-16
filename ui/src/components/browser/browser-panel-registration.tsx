import { untrack } from "@solidjs/signals";
import { onCleanup, onSettled } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import { nativePanelTabStripCss as tabStyles } from "../panel-tab-strip-styles.ts";
import { definePanelBridge } from "../solid-panel-bridge.tsx";
import { usePanelController } from "../solid-panel-controller.ts";
import type { BrowserPanelInputs, BrowserPanelPresentation } from "./browser-panel-presentation.ts";
import { BrowserPanelChrome } from "./browser-panel-render.tsx";
import dockStyles from "../dock-panel-solid.css?inline";
import browserStyles from "./browser-panel.css?inline";

export type { BrowserPanelInputs } from "./browser-panel-presentation.ts";

function BrowserPanelContent(props: { controller: BrowserPanelPresentation }) {
  const controller = untrack(() => props.controller);
  // Seed retained native tabs before the connected panel restores its open view.
  onSettled(() => controller.browserPanelController.native.mount());
  usePanelController(controller);
  // Cleanup runs before the adapter disconnects and settles its DOM-completion fence.
  onCleanup(() => controller.browserPanelController.suspendView());
  const panel = () => controller.read();
  return (
    <>
      {panel().available && (panel().embedded || panel().dockLayout.open) ? (
        <BrowserPanelChrome
          controller={panel().browserPanelController}
          dock={panel().dockLayout.dock}
          height={panel().dockLayout.height}
          width={panel().dockLayout.width}
          onDockChange={(dock) => panel().dockLayout.setDock(dock)}
          onClose={() => panel().closePanel()}
          resizer={
            <DockResizer
              controller={panel().dockLayout}
              classPrefix="bp"
              label={t("browser.resize")}
            />
          }
          embedded={panel().embedded}
          tabsInHeader={panel().tabsInHeader}
        />
      ) : null}
    </>
  );
}

export function defineBrowserPanelElement(
  createController: (element: HTMLElement) => BrowserPanelPresentation,
  tag = "openclaw-browser-panel",
) {
  return definePanelBridge<
    BrowserPanelInputs,
    BrowserPanelPresentation,
    | "browserPanelIsOpen"
    | "toggle"
    | "handleToggleRequest"
    | "selectHostedTab"
    | "closeHostedTab"
    | "requestUpdate"
  >(
    tag,
    createController,
    (controller) => (
      <>
        <style>
          {`${dockStyles}\n${tabStyles}\n${browserStyles}`.replaceAll(
            "openclaw-browser-panel",
            tag,
          )}
        </style>
        <BrowserPanelContent controller={controller} />
      </>
    ),
    {
      properties: {
        client: { default: null, attribute: false },
        available: { default: false, type: Boolean },
        remoteAvailable: { default: true, type: Boolean },
        suppressed: { default: false, type: Boolean },
        resourceBasePath: { default: "", attribute: false },
        authToken: { default: null, attribute: false },
        embedded: { default: false, type: Boolean, reflect: true },
        tabsInHeader: { default: false, type: Boolean },
        presented: { default: false, type: Boolean },
        refreshOnPresentation: { default: true, type: Boolean },
        sessionKey: { default: "", attribute: false },
        sessionTabs: { default: [], attribute: false },
        preferredTab: { default: undefined, attribute: false },
        fixedTab: { default: undefined, attribute: false },
        dashboardTarget: { default: undefined, attribute: false },
      },
      methods: [
        "browserPanelIsOpen",
        "toggle",
        "handleToggleRequest",
        "selectHostedTab",
        "closeHostedTab",
        "requestUpdate",
      ],
      getters: [
        "renderRoot",
        "hasUpdated",
        "hostedTabs",
        "activeHostedTabId",
        "browserPanelController",
      ],
    },
  );
}
