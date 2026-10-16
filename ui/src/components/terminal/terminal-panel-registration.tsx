import { createMemo, untrack } from "solid-js";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { nativePanelTabStripCss as tabStyles } from "../panel-tab-strip-styles.ts";
import "../dock-panel-solid.css";
import "./terminal-panel.css";
import { definePanelBridge } from "../solid-panel-bridge.tsx";
import { usePanelController } from "../solid-panel-controller.ts";
import { TerminalPanelHostedActions, TerminalPanelView } from "./terminal-panel-view.tsx";
import { CATALOG_TERMINAL_READY_TIMEOUT_MS, TerminalPanelController } from "./terminal-panel.ts";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";
import dockStyles from "../dock-panel-solid.css?inline";
import terminalStyles from "./terminal-panel.css?inline";

export type TerminalInputs = Pick<
  TerminalPanelController,
  | "client"
  | "agentId"
  | "sessionKey"
  | "available"
  | "suppressed"
  | "themeMode"
  | "basePath"
  | "fullscreen"
  | "embedded"
  | "onClose"
  | "tabsInHeader"
  | "page"
  | "routeTarget"
  | "createTerminalController"
  | "catalogReadyTimeoutMs"
>;

function TerminalPanel(props: { controller: TerminalPanelController }) {
  // A bridge mount owns one controller until its host disconnects.
  const controller = untrack(() => props.controller);
  usePanelController(controller);
  const view = createMemo(() => controller.read().viewState);
  // The side-panel header moves this Solid-owned node outside the panel's host.
  <TerminalPanelHostedActions
    view={view}
    ref={(element) => {
      controller.hostedActionsContent = element;
    }}
  />;
  return <TerminalPanelView view={view} />;
}

export function defineTerminalPanelElement(
  tag = "openclaw-terminal-panel",
  createController: (element: HTMLElement) => TerminalPanelController = (element) =>
    new TerminalPanelController(element),
) {
  return definePanelBridge<
    TerminalInputs,
    TerminalPanelController,
    | "activateTerminalHost"
    | "toggle"
    | "closeTerminalPanel"
    | "hideTerminalPanelForUnavailableSurface"
    | "restoreTerminalPanelOpenState"
    | "resetTerminalSessionPicker"
    | "findTerminalPanelViewport"
    | "selectHostedTab"
    | "closeHostedTab"
    | "handleToggleRequest"
    | "requestUpdate"
  >(
    tag,
    createController,
    (controller) => {
      const application = useOptionalApplication();
      if (application) {
        controller.context = application;
      }
      const styles = `${dockStyles}\n${tabStyles}\n${terminalStyles}`.replaceAll(
        "openclaw-terminal-panel",
        tag,
      );
      return (
        <>
          <style>{styles}</style>
          <TerminalPanel controller={controller} />
        </>
      );
    },
    {
      properties: {
        client: { default: null, attribute: false },
        agentId: { default: null, attribute: false },
        sessionKey: { default: null, attribute: false },
        available: { default: false, type: Boolean },
        suppressed: { default: false, type: Boolean },
        themeMode: { default: "dark", attribute: false },
        basePath: { default: "", attribute: false },
        fullscreen: { default: false, type: Boolean, reflect: true },
        embedded: { default: false, type: Boolean, reflect: true },
        onClose: { default: undefined, attribute: false },
        tabsInHeader: { default: false, type: Boolean },
        page: { default: false, type: Boolean },
        routeTarget: { default: null, attribute: false },
        createTerminalController: { default: createIsolatedGhosttyTerminal, attribute: false },
        catalogReadyTimeoutMs: { default: CATALOG_TERMINAL_READY_TIMEOUT_MS, attribute: false },
      },
      methods: [
        "activateTerminalHost",
        "toggle",
        "closeTerminalPanel",
        "hideTerminalPanelForUnavailableSurface",
        "restoreTerminalPanelOpenState",
        "resetTerminalSessionPicker",
        "findTerminalPanelViewport",
        "selectHostedTab",
        "closeHostedTab",
        "handleToggleRequest",
        "requestUpdate",
      ],
      getters: [
        "renderRoot",
        "hasUpdated",
        "hostedTabs",
        "activeHostedTabId",
        "hostedActions",
        "terminalPanelOpen",
        "terminalPanelUploadController",
      ],
    },
  );
}

export const TerminalPanelHost = defineTerminalPanelElement();
