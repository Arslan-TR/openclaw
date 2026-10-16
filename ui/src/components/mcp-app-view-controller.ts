import { PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { isMcpAppViewExpiredError } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { raceWithTimeout } from "@openclaw/retry";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { navigateMcpAppLink } from "../app/mcp-app-routing.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { t as translate } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { parseMcpAppLink } from "../lib/mcp-app-route.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import type { SolidBridgeElement } from "../lit/solid-bridge.ts";
import { OpenClawAppBridge, bindMcpAppResourceHandlers } from "./mcp-app-bridge.ts";
import { McpAppConfirm } from "./mcp-app-confirm.ts";
import {
  buildMcpAppFrameHostContext,
  loadMcpAppSandbox,
  waitForMcpAppHandlerRegistration,
  waitForMcpAppInitialization,
} from "./mcp-app-frame.ts";
import {
  buildMcpAppHostCapabilities,
  dispatchMcpAppMessage,
  isWidgetFrameInteractable,
  negotiateMcpAppDisplayModes,
  MCP_APP_CONTEXT_EVENT,
  type McpAppContextState,
  type McpAppContextEventDetail,
  MCP_APP_VIEW_EXPIRED_EVENT,
  type McpAppHostSandboxCsp,
} from "./mcp-app-security.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

registerMcpAppEnglish();

type McpAppViewPayload = {
  sandboxUrl: string;
  sandboxPort: number;
  sandboxOrigin?: string;
  html: string;
  csp?: McpAppHostSandboxCsp;
  toolInput: unknown;
  toolResult: Parameters<OpenClawAppBridge["sendToolResult"]>[0];
  messageSupported?: boolean;
  updateModelContextSupported?: boolean;
  richModelContextSupported?: boolean;
  fileResourcesSupported?: boolean;
  openFilesSupported?: boolean;
  hostContext?: { "openai/modelContext"?: McpAppContextState; "openai/deepLink"?: { url: string } };
  displayMode?: "inline" | "fullscreen";
  displayModes?: {
    availableDisplayModes?: Array<"inline" | "fullscreen">;
    preferredDisplayMode?: "inline" | "fullscreen";
  };
};

type McpAppResources = {
  bridge: OpenClawAppBridge | null;
  cleanups: Set<() => void>;
  frameHeight: number;
  iframe: HTMLIFrameElement;
  transport: { close(): Promise<void> } | null;
  disposed: boolean;
  updateHostContext?: () => void;
  reconnect?: () => Promise<void>;
};
type McpAppBinding = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  sessionKey: string;
  viewId: string;
  agentId?: string;
  connectionRevision: number | undefined;
  scope: number;
};

const MCP_APP_TEARDOWN_TIMEOUT_MS = 250;

export type McpAppViewProps = {
  sessionKey: string;
  agentId: string;
  viewId: string;
  height: number;
  fillContainer: boolean;
  surface: "conversation" | "board";
  title: string;
  deepLink: string | undefined;
  onRelaunch: (() => void) | undefined;
  onHeightChange: ((height: number) => void) | undefined;
  relaunching: boolean;
  displayMode: "inline" | "fullscreen";
};
export type ViewMethods = { teardown(): Promise<void>; restartAfterTeardown(): void };
export type McpAppViewElement = SolidBridgeElement<McpAppViewProps, ViewMethods>;

/** Owns the live frame and protocol resources independently of rendering. */
export class McpAppViewController {
  private inactiveValue: "ended" | "reconstructed" | null = null;
  error: unknown = null;
  readonly confirmation = new McpAppConfirm(() => this.notify());
  mount: HTMLDivElement | undefined;
  private resources: McpAppResources | null = null;
  private teardownPromise: Promise<void> | null = null;
  private setupAbort: AbortController | undefined;
  private requestAbort = new AbortController();

  constructor(
    readonly host: McpAppViewElement,
    readonly context: ApplicationContext,
    readonly notify: () => void,
  ) {}
  get inactive() {
    return this.inactiveValue;
  }
  set inactive(value: "ended" | "reconstructed" | null) {
    this.inactiveValue = value;
    this.notify();
  }
  connectionChanged() {
    this.requestAbort.abort();
    this.requestAbort = new AbortController();
    this.confirmation.cancel();
    if (this.context.gateway.snapshot.phase === "connected") {
      const resources = this.resources;
      if (!resources) {
        void this.setup(this.binding());
      } else if (resources.reconnect) {
        const signal = this.requestAbort.signal;
        void resources.reconnect().then(
          () => {
            if (!signal.aborted && this.resources === resources && this.error) {
              this.error = null;
              this.notify();
            }
          },
          (error: unknown) => {
            if (!signal.aborted && this.resources === resources) {
              this.error = error;
              this.notify();
            }
          },
        );
      }
    }
  }
  async setup(binding: McpAppBinding | null) {
    this.setupAbort?.abort();
    const abort = new AbortController();
    this.setupAbort = abort;
    this.error = null;
    this.notify();
    try {
      await this.teardownResources(this.resources);
      abort.signal.throwIfAborted();
      this.inactive = null;
      if (!this.host.sessionKey || !this.host.viewId) {
        return;
      }
      if (!binding) {
        throw new Error(translate("mcpApp.errors.gatewayUnavailable"));
      }
      await this.setupResources(binding, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) {
        this.error = error;
        this.notify();
      }
    }
  }

  updateTitle() {
    if (this.resources) {
      this.resources.iframe.title = this.host.title || translate("mcpApp.title");
    }
  }

  updateReservedHeight() {
    if (this.mount) {
      this.mount.style.minHeight =
        this.host.surface === "conversation" &&
        !this.host.fillContainer &&
        this.host.displayMode === "inline"
          ? `${this.resources?.frameHeight ?? this.host.height}px`
          : "";
      if (this.host.onHeightChange) {
        this.host.style.minHeight = "";
      }
    }
  }

  updatePresentation() {
    this.confirmation.update();
    if (this.host.displayMode === "fullscreen") {
      promoteToPopoverTopLayer(this.host);
    } else {
      this.host.removeAttribute("popover");
    }
    if (this.resources) {
      this.resources.frameHeight = this.host.height;
      this.resources.iframe.style.height =
        this.host.fillContainer || this.host.displayMode === "fullscreen"
          ? "100%"
          : `${this.host.height}px`;
      this.resources.updateHostContext?.();
    }
    this.updateReservedHeight();
  }

  private async request<T = unknown>(
    binding: McpAppBinding,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestSignal = signal
      ? AbortSignal.any([signal, this.requestAbort.signal])
      : this.requestAbort.signal;
    try {
      requestSignal.throwIfAborted();
      const gateway = this.context.gateway;
      if (
        gateway.snapshot.phase !== "connected" ||
        gateway.snapshot.client !== binding.client ||
        !hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null) ||
        gatewayPresentationScope(gateway).key !== binding.scope
      ) {
        throw new Error(translate("mcpApp.errors.gatewayUnavailable"));
      }
      const { agentId: _untrustedAgent, ...operationParams } = params;
      const requestParams = {
        ...operationParams,
        sessionKey: binding.sessionKey,
        viewId: binding.viewId,
        ...(binding.agentId ? { agentId: binding.agentId } : {}),
      };
      const result = await binding.client.request<T>(method, requestParams, {
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      return result;
    } catch (error) {
      if (
        isMcpAppViewExpiredError(error) &&
        !requestSignal.aborted &&
        this.host.viewId === binding.viewId &&
        this.host.sessionKey === binding.sessionKey &&
        this.context.gateway.snapshot.client === binding.client
      ) {
        this.inactive = "ended";
        this.confirmation.cancel();
        this.host.dispatchEvent(
          new CustomEvent(MCP_APP_VIEW_EXPIRED_EVENT, { bubbles: true, composed: true }),
        );
      }
      throw error;
    }
  }

  private addResourceCleanup(resources: McpAppResources, cleanup: () => void): () => void {
    resources.cleanups.add(cleanup);
    return () => {
      if (resources.cleanups.delete(cleanup)) {
        cleanup();
      }
    };
  }

  private async teardownResources(resources: McpAppResources | null | undefined) {
    if (!resources || resources.disposed) {
      await this.teardownPromise;
      return;
    }
    resources.disposed = true;
    if (this.resources === resources) {
      this.resources = null;
    }
    for (const cleanup of resources.cleanups) {
      resources.cleanups.delete(cleanup);
      cleanup();
    }
    const teardown = (async () => {
      if (resources.bridge) {
        await raceWithTimeout(
          resources.bridge.teardownResource({}).catch(() => undefined),
          MCP_APP_TEARDOWN_TIMEOUT_MS,
          () => undefined,
        );
      }
      await resources.transport?.close().catch(() => undefined);
      resources.iframe.remove();
    })();
    this.teardownPromise = teardown;
    try {
      await teardown;
    } finally {
      if (this.teardownPromise === teardown) {
        this.teardownPromise = null;
      }
    }
  }

  /** Parent render owners await this before removing the connected view. */
  async teardown() {
    this.setupAbort?.abort();
    await this.teardownResources(this.resources);
  }

  /** Restarts a torn-down view only when its parent kept the element connected. */
  restartAfterTeardown() {
    if (!this.host.isConnected || this.resources || this.teardownPromise) {
      return;
    }
    this.requestAbort = new AbortController();
    void this.setup(this.binding());
  }

  binding(): McpAppBinding | null {
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    const denied =
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.hello !== null &&
      !hasOperatorReadAccess(gateway.snapshot.hello.auth ?? null);
    return client && !denied
      ? {
          client,
          sessionKey: this.host.sessionKey,
          viewId: this.host.viewId,
          agentId: this.host.agentId || undefined,
          connectionRevision: gateway.connectionRevision,
          scope: gatewayPresentationScope(gateway).key,
        }
      : null;
  }

  private isCurrentBinding(
    binding: McpAppBinding,
    resources: McpAppResources,
    signal: AbortSignal,
  ): boolean {
    const gateway = this.context.gateway;
    return (
      !signal.aborted &&
      !resources.disposed &&
      this.resources === resources &&
      this.host.isConnected &&
      this.inactive !== "ended" &&
      this.host.sessionKey === binding.sessionKey &&
      this.host.viewId === binding.viewId &&
      (this.host.agentId || undefined) === binding.agentId &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.client === binding.client &&
      hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null) &&
      gateway.connectionRevision === binding.connectionRevision &&
      gatewayPresentationScope(gateway).key === binding.scope
    );
  }

  private bindOpenLinkHandler(
    bridge: OpenClawAppBridge,
    binding: McpAppBinding,
    resources: McpAppResources,
    signal: AbortSignal,
  ) {
    bridge.onopenlink = ({ url }) => {
      const context = this.context;
      // Both external and plugin navigation require the current, focused App.
      if (
        !this.isCurrentBinding(binding, resources, signal) ||
        !isWidgetFrameInteractable(resources.iframe)
      ) {
        return Promise.resolve({ isError: true });
      }
      if (!parseMcpAppLink(url)) {
        return Promise.resolve(openExternalUrlSafe(url) ? {} : { isError: true });
      }
      return Promise.resolve(navigateMcpAppLink(context, url) ? {} : { isError: true });
    };
  }

  private async setupResources(
    binding: McpAppBinding,
    signal: AbortSignal,
  ): Promise<McpAppResources> {
    const { sessionKey, viewId, agentId } = binding;
    let resources: McpAppResources | null = null;
    try {
      const payload = await this.request<McpAppViewPayload>(binding, "mcp.app.view", {}, signal);
      const mount = this.mount;
      signal.throwIfAborted();
      this.inactive = payload.messageSupported === false ? "reconstructed" : null;
      if (!mount) {
        throw new Error(translate("mcpApp.errors.mountUnavailable"));
      }
      const iframe = document.createElement("iframe");
      iframe.title = this.host.title || translate("mcpApp.title");
      // The isolated proxy binds its parent before accepting messages. Only the
      // Control UI origin is disclosed; path/query data remains suppressed.
      iframe.referrerPolicy = "origin";
      iframe.style.height = this.host.fillContainer ? "100%" : `${this.host.height}px`;
      // The proxy listener is a dedicated origin that never serves host data,
      // so Apps retain their required origin capabilities without reaching Control UI.
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      mount.appendChild(iframe);
      const createdResources: McpAppResources = {
        bridge: null,
        cleanups: new Set(),
        frameHeight: this.host.height,
        iframe,
        transport: null,
        disposed: false,
      };
      resources = createdResources;
      this.resources = createdResources;
      this.addResourceCleanup(createdResources, () => this.confirmation.cancel());
      signal.addEventListener("abort", () => void this.teardownResources(createdResources), {
        once: true,
      });

      const addCleanup = (cleanup: () => void) =>
        this.addResourceCleanup(createdResources, cleanup);
      await loadMcpAppSandbox(
        iframe,
        resolveSandboxHostUrl(
          payload.sandboxUrl,
          payload.sandboxPort,
          payload.sandboxOrigin,
          this.context.gateway.connection.gatewayUrl,
          window.location.origin,
          translate("mcpApp.errors.invalidSandboxUrl"),
        ),
        addCleanup,
      );
      signal.throwIfAborted();
      if (!iframe.contentWindow) {
        throw new Error(translate("mcpApp.errors.sandboxUnavailable"));
      }

      let modes = negotiateMcpAppDisplayModes(payload.displayModes);
      this.host.displayMode =
        payload.displayMode && modes.available.includes(payload.displayMode)
          ? payload.displayMode
          : modes.initial;
      let modelContext = payload.hostContext?.["openai/modelContext"] ?? null;
      let contextGeneration = 0;
      const buildHostContext = () => {
        const deepLink = this.host.deepLink
          ? { url: this.host.deepLink }
          : payload.hostContext?.["openai/deepLink"];
        if (
          deepLink &&
          (!deepLink.url.startsWith("/") ||
            deepLink.url.startsWith("//") ||
            deepLink.url.includes("#"))
        ) {
          throw new Error("Invalid App deep link");
        }
        return {
          ...buildMcpAppFrameHostContext(
            mount,
            createdResources.frameHeight,
            this.host.fillContainer || this.host.displayMode === "fullscreen",
            this.host.displayMode,
            modes.available,
          ),
          "openai/modelContext": modelContext,
          ...(deepLink ? { "openai/deepLink": deepLink } : {}),
        };
      };
      const publishContext = () =>
        this.host.dispatchEvent(
          new CustomEvent<McpAppContextEventDetail>(MCP_APP_CONTEXT_EVENT, {
            bubbles: true,
            composed: true,
            detail: { sessionKey, viewId, state: modelContext },
          }),
        );
      const bridge = new OpenClawAppBridge(
        null,
        { name: "OpenClaw", version: "1.0.0" },
        buildMcpAppHostCapabilities(
          payload.csp,
          Boolean(payload.messageSupported),
          Boolean(payload.updateModelContextSupported),
          {
            richModelContext: Boolean(payload.richModelContextSupported),
            fileResources: Boolean(payload.fileResourcesSupported),
            openFiles: Boolean(payload.openFilesSupported),
          },
        ),
        { hostContext: buildHostContext() },
      );
      createdResources.bridge = bridge;
      const request = <T = unknown>(method: string, params: Record<string, unknown>) =>
        this.request<T>(binding, method, params, signal);
      const isCurrent = () => this.isCurrentBinding(binding, createdResources, signal);
      const confirm = (text: string, kind: "message" | "file") =>
        this.confirmation.request({
          frame: iframe,
          title: this.host.title || translate("mcpApp.title"),
          text,
          kind,
          isCurrent,
        });
      const refreshModelContext = (clearedUpdateId?: string) => {
        if (clearedUpdateId && modelContext && modelContext.updateId !== clearedUpdateId) {
          return undefined;
        }
        const generation = ++contextGeneration;
        const requestSignal = this.requestAbort.signal;
        const publish = (nextContext: McpAppContextState) => {
          if (
            createdResources.disposed ||
            requestSignal.aborted ||
            generation !== contextGeneration
          ) {
            return;
          }
          modelContext = nextContext;
          bridge.setHostContext(buildHostContext());
          publishContext();
        };
        if (clearedUpdateId) {
          publish(null);
          return undefined;
        }
        return request<{ state: McpAppContextState }>("mcp.app.modelContext", {}).then(
          (response) => publish(response.state),
          () => undefined,
        );
      };
      const handleRequestTeardown = () => {
        void this.teardown();
      };
      bridge.onrequestteardown = handleRequestTeardown;
      this.addResourceCleanup(createdResources, () => {
        if (bridge.onrequestteardown === handleRequestTeardown) {
          bridge.onrequestteardown = undefined;
        }
      });
      if (payload.messageSupported) {
        bridge.setMessageHandler(async (params) => {
          const accepted = await dispatchMcpAppMessage(
            iframe,
            { sessionKey, viewId },
            params,
            (prompt) => confirm(prompt, "message"),
            isCurrent,
          );
          return accepted ? {} : { isError: true };
        });
      }
      if (payload.updateModelContextSupported) {
        bridge.setUpdateModelContextHandler(async (params) => {
          const result = await request<{ _meta?: Record<string, unknown> }>(
            "mcp.app.updateModelContext",
            { ...params },
          );
          await refreshModelContext();
          return result;
        });
      }
      const notifications = bindMcpAppResourceHandlers({
        bridge,
        request,
        releaseResourceSubscription: (uri) =>
          this.request(binding, "mcp.app.unsubscribeResource", { uri }),
        sessionKey,
        viewId,
        iframe,
        agentId,
        fileResourcesSupported: payload.fileResourcesSupported,
        openFilesSupported: payload.openFilesSupported,
        confirmOpenFile: (path) => confirm(path, "file"),
        isDisposed: () => !isCurrent(),
        addCleanup: (cleanup) => {
          this.addResourceCleanup(createdResources, cleanup);
        },
        dispatchEvent: (event) => this.host.dispatchEvent(event),
        onModelContextChanged: (clearedUpdateId) => {
          void refreshModelContext(clearedUpdateId)?.catch(() => undefined);
        },
        onConversationInputRequested: () => {
          this.host.displayMode = "inline";
        },
        subscribeEvents: (listener) => this.context.gateway.subscribeEvents(listener),
      });
      bridge.onrequestdisplaymode = ({ mode }) => {
        if ((mode !== "inline" && mode !== "fullscreen") || !modes.available.includes(mode)) {
          return Promise.resolve({ mode: this.host.displayMode });
        }
        this.host.displayMode = mode;
        iframe.style.height =
          mode === "fullscreen" || this.host.fillContainer
            ? "100%"
            : `${createdResources.frameHeight}px`;
        bridge.setHostContext(buildHostContext());
        return Promise.resolve({ mode });
      };
      this.bindOpenLinkHandler(bridge, binding, createdResources, signal);
      bridge.onsizechange = ({ height }) => {
        if (
          height !== undefined &&
          Number.isFinite(height) &&
          isCurrent() &&
          !this.host.fillContainer &&
          this.host.displayMode !== "fullscreen"
        ) {
          const nextHeight = Math.min(1200, Math.max(160, Math.round(height)));
          createdResources.frameHeight = nextHeight;
          iframe.style.height = `${nextHeight}px`;
          this.updateReservedHeight();
          this.host.onHeightChange?.(nextHeight);
          bridge.setHostContext(buildHostContext());
        }
      };
      const initialized = new Promise<void>((resolve) => {
        bridge.oninitialized = () => {
          modes = negotiateMcpAppDisplayModes(
            payload.displayModes,
            bridge.getAppCapabilities()?.availableDisplayModes,
          );
          this.host.displayMode =
            payload.displayMode && modes.available.includes(payload.displayMode)
              ? payload.displayMode
              : modes.initial;
          resolve();
        };
      });
      const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
      createdResources.transport = transport;
      await bridge.connect(transport);
      signal.throwIfAborted();
      await bridge.sendSandboxResourceReady({
        html: payload.html,
        csp: payload.csp,
      });
      await waitForMcpAppInitialization(initialized, addCleanup);
      signal.throwIfAborted();
      const updateHostContext = () => bridge.setHostContext(buildHostContext());
      createdResources.updateHostContext = updateHostContext;
      updateHostContext();
      publishContext();
      notifications.start();
      createdResources.reconnect = async () => {
        await notifications.reconnect();
        if (payload.updateModelContextSupported) {
          await refreshModelContext();
        }
      };
      this.addResourceCleanup(createdResources, this.context.theme.subscribe(updateHostContext));
      if (typeof ResizeObserver !== "undefined") {
        const hostResizeObserver = new ResizeObserver(updateHostContext);
        hostResizeObserver.observe(mount);
        this.addResourceCleanup(createdResources, () => hostResizeObserver.disconnect());
      }
      await waitForMcpAppHandlerRegistration();
      signal.throwIfAborted();
      await bridge.sendToolInput({
        arguments: asOptionalRecord(payload.toolInput) ?? {},
      });
      await bridge.sendToolResult(payload.toolResult);
      signal.throwIfAborted();
      return createdResources;
    } catch (error) {
      await this.teardownResources(resources);
      throw error;
    }
  }
}
