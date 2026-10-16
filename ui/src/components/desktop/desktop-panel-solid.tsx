import type { JSX } from "@solidjs/web";
import { createEffect, createMemo } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createDesktopFullscreen } from "../desktop-fullscreen.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import { FullscreenButton } from "../fullscreen-solid.tsx";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import { usePanelController } from "../solid-panel-controller.ts";
import { createDesktopAppLauncher } from "./desktop-app-launcher.ts";
import { DesktopAudioControl, DesktopAudioNotice } from "./desktop-audio-view.tsx";
import { createDesktopAudio } from "./desktop-audio.ts";
import { DesktopDocumentView } from "./desktop-document-view.tsx";
import { openDesktopFocus } from "./desktop-focus-window.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type { DesktopPanelController } from "./desktop-panel-controller.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";
import {
  DesktopPanelRecovery,
  DesktopCredentials,
  DesktopPicker,
  DesktopNotice,
  DesktopPanelView,
} from "./desktop-panel-view.tsx";
import {
  createDesktopPictureInPicture,
  type DesktopPictureInPicture,
} from "./desktop-picture-in-picture.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

export function DesktopPanelContent(props: { controller: DesktopPanelController }) {
  const controller = props.controller;
  controller.audio = createDesktopAudio(controller, controller.audioTarget);
  controller.mobileKeyboard = createDesktopMobileKeyboard(controller.keyboardTarget);
  controller.pictureInPicture = createDesktopPictureInPicture(controller, () => {
    const target = controller.launchTarget;
    return controller.available && target.state === "connected" && target.presented
      ? controller.renderRoot.querySelector<HTMLCanvasElement>(".desktop-surface canvas")
      : null;
  });
  controller.launcher = createDesktopAppLauncher(() => controller.launchTarget);
  const fullscreen = createDesktopFullscreen(controller.ownerDocument);
  controller.fullscreenMode = fullscreen;
  createEffect(fullscreen.active, () => controller.dockLayout.syncReservation());
  usePanelController(controller);
  const standalone = createMemo(() => !controller.read().embedded);
  createEffect(standalone, (active) =>
    active ? listen(window, DESKTOP_PANEL_TOGGLE_EVENT, controller.handleToggleRequest) : undefined,
  );
  const sessionClient = createMemo(() => {
    const current = controller.read();
    return current.available && current.suppliedEnvironments === null ? current.client : null;
  });
  createEffect(sessionClient, (client) =>
    client ? controller.sessionSource.subscribe(client) : undefined,
  );
  return (
    <>
      {controller.read().available &&
        (controller.read().documentMode ||
          controller.read().embedded ||
          controller.read().view.dockLayout.open) && (
          <DesktopPresentation view={controller.read().view} />
        )}
    </>
  );
}

function PictureInPictureButton(props: {
  controller: DesktopPictureInPicture;
  connected: boolean;
  documentMode: boolean;
}) {
  const label = () =>
    t(
      props.controller.feedback().active
        ? "desktop.exitPictureInPicture"
        : props.controller.supported()
          ? "desktop.enterPictureInPicture"
          : "desktop.pictureInPictureUnavailable",
    );
  return (
    <button
      class={[
        props.documentMode ? "desktop-touch-action" : "desktop-toolbar-action",
        "desktop-picture-in-picture-button",
      ]}
      type="button"
      title={label()}
      aria-label={label()}
      aria-pressed={props.controller.feedback().active ? "true" : "false"}
      aria-busy={props.controller.feedback().pending ? "true" : "false"}
      disabled={
        !props.controller.supported() || !props.connected || props.controller.feedback().pending
      }
      onClick={() => void props.controller.toggle()}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="2" y="3" width="20" height="18" rx="2" />
        <rect x="12" y="11" width="7" height="7" rx="1" />
      </svg>
    </button>
  );
}

/** Compose the document and dock views without owning connection state. */
function DesktopPresentation(props: { view: DesktopPanelController["view"] }) {
  const content = {
    get state(): DesktopPanelState {
      return props.view.content.state === "picker" &&
        props.view.content.loading &&
        props.view.content.automaticSource &&
        props.view.content.hasTarget
        ? "connecting"
        : props.view.content.state;
    },
    notice(): JSX.Element {
      return (
        <>
          <DesktopNotice
            errorText={
              props.view.pictureInPicture.feedback().errorText ??
              props.view.fullscreenMode.errorText() ??
              props.view.content.errorText
            }
            noticeText={props.view.content.noticeText}
            availability={props.view.content.availability}
          />
          <DesktopAudioNotice state={props.view.audio.state()} />
          {props.view.startup && (
            <DesktopNotice
              errorText={null}
              noticeText={t(
                props.view.startup.worker?.state === "bootstrapping"
                  ? "desktop.preparing"
                  : "desktop.starting",
              )}
            />
          )}
        </>
      );
    },
    picker(): JSX.Element {
      return <DesktopPicker {...props.view.content.picker} loading={props.view.content.loading} />;
    },
    credentials(): JSX.Element {
      return <DesktopCredentials {...props.view.content.credentials} />;
    },
    recovery(): JSX.Element {
      return (
        <DesktopPanelRecovery
          {...props.view.content.recovery}
          inventoryError={props.view.content.state === "inventory-error"}
        />
      );
    },
  };
  const pictureInPictureControl = () => (
    <PictureInPictureButton
      controller={props.view.pictureInPicture}
      connected={props.view.content.state === "connected"}
      documentMode={props.view.documentMode}
    />
  );
  const audioControl = () => (
    <DesktopAudioControl
      state={props.view.audio.state()}
      connected={props.view.content.state === "connected"}
      documentMode={props.view.documentMode}
      onToggle={() => props.view.audio.toggle()}
    />
  );
  return (
    <>
      {props.view.documentMode ? (
        <DesktopDocumentView
          {...content}
          controlling={props.view.controlling}
          sizing={props.view.sizing}
          keyboard={props.view.mobileKeyboard}
          pictureInPictureControl={pictureInPictureControl()}
          audioControl={audioControl()}
          onControlToggle={props.view.onControlToggle}
          onClose={props.view.onDocumentClose}
        />
      ) : (
        <DesktopPanelView
          embedded={props.view.embedded}
          workspaceControls={props.view.workspaceControls}
          dock={props.view.dockLayout.dock}
          height={props.view.dockLayout.height}
          width={props.view.dockLayout.width}
          fullscreen={props.view.fullscreenMode.active()}
          sectionRef={props.view.fullscreenMode.sectionRef}
          renderResizer={() =>
            !props.view.fullscreenMode.active() && (
              <DockResizer
                controller={props.view.dockLayout}
                classPrefix="bp"
                label={t("desktop.resize")}
              />
            )
          }
          renderFullscreenControl={() => (
            <FullscreenButton controller={props.view.fullscreenMode} />
          )}
          onDock={(dock) => props.view.dockLayout.setDock(dock)}
          onOpenWindow={() => {
            const target = props.view.focusTarget();
            // Read the current target at click time; workspace pop-outs never take input.
            openDesktopFocus(
              target.basePath,
              target.source,
              target.workspaceControls ? false : target.control,
            );
          }}
          onClose={props.view.onClose}
          content={content}
          connection={{
            get controlling() {
              return props.view.controlling;
            },
            get desktopApps() {
              return props.view.desktopApps;
            },
            get launchingApp() {
              return props.view.launchingApp;
            },
            get showApps() {
              const target = props.view.focusTarget();
              return (
                target.source !== null &&
                desktopSourceForEnvironment({ id: target.source }).kind === "environment"
              );
            },
            get sizing() {
              return props.view.sizing;
            },
            get pictureInPictureControl() {
              return pictureInPictureControl();
            },
            get audioControl() {
              return audioControl();
            },
            onLaunch: (app) => props.view.onLaunch(app),
            onTakeControl: () => props.view.onTakeControl(),
            onControlToggle: () => props.view.onControlToggle(),
            onDisconnect: () => props.view.onDisconnect(),
          }}
        />
      )}
    </>
  );
}
