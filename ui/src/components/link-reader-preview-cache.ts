import { pruneMapToMaxSize } from "../../../src/infra/map-size.ts";
import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { subscribeToSharedRequest } from "../lib/shared-request-subscription.ts";
import type { HovercardProperties } from "./link-reader-hovercard.types.ts";
import {
  parsePreviewResponse,
  previewContextFor,
  type CacheEntry,
  type PreviewContext,
} from "./link-reader-preview.tsx";
import { linkReaderTargetKey, type LinkReaderTarget } from "./link-reader-target.ts";

const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;

/** Provider-scoped settled metadata and generation-fenced shared requests. */
export class LinkReaderPreviewCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly host: Pick<HovercardProperties, "client" | "agentId" | "readers">,
    private readonly context: () => PreviewContext | null,
    private readonly onChange: () => void,
  ) {}

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.controller.abort();
    }
    this.entries.clear();
  }

  syncGeneration(): void {
    for (const [key, entry] of this.entries) {
      if (!entry.preview && entry.generation !== this.host.client?.connectionGeneration) {
        entry.controller.abort();
        this.entries.delete(key);
      }
    }
  }

  get(target: LinkReaderTarget): CacheEntry | undefined {
    const cached = this.entries.get(linkReaderTargetKey(target));
    const client = this.host.client;
    return cached &&
      !cached.controller.signal.aborted &&
      ((!client?.connected && cached.preview) ||
        (cached.expiresAt > Date.now() && cached.generation === client?.connectionGeneration))
      ? cached
      : undefined;
  }

  load(target: LinkReaderTarget, signal: AbortSignal): Promise<ControlUiLinkReaderPreview> {
    const key = linkReaderTargetKey(target);
    const previous = this.entries.get(key);
    const cached = this.get(target);
    this.entries.delete(key);
    // Dismissal invalidates only that request, even before its rejection settles.
    if (cached) {
      this.entries.set(key, cached);
      return subscribeToSharedRequest(cached, {}, signal);
    }

    const client = this.host.client;
    const method = target.reader.linkReader.previewMethod;
    if (!client?.connected || !method || !this.host.readers.includes(target.reader)) {
      return Promise.reject(new Error("Link preview requires an available reader"));
    }
    const controller = new AbortController();
    const context = this.context();
    const agentId = this.host.agentId;
    const entry: CacheEntry = {
      generation: client.connectionGeneration,
      preview: previous?.preview,
      expiresAt: Date.now() + SUCCESS_CACHE_MS,
      controller,
      subscribers: new Set(),
      promise: client
        .request<ControlUiLinkReaderPreview>(
          method,
          { ...(agentId ? { agentId } : {}), url: target.href },
          { signal: controller.signal },
        )
        .then((response) => {
          const preview = parsePreviewResponse(target, response);
          if (
            !controller.signal.aborted &&
            this.entries.get(key) === entry &&
            client === this.host.client &&
            agentId === this.host.agentId &&
            client.connectionGeneration === entry.generation &&
            previewContextFor(client, agentId) === context
          ) {
            entry.preview = preview;
            this.onChange();
          }
          return preview;
        })
        .catch((error: unknown) => {
          if (
            error instanceof GatewayRequestError &&
            client.connected &&
            client.connectionGeneration === entry.generation
          ) {
            // Explicit reader failures back off; interrupted transport is not missing metadata.
            entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
          } else if (this.entries.get(key) === entry) {
            if (previous?.preview) {
              this.entries.set(key, previous);
            } else {
              this.entries.delete(key);
            }
          }
          this.onChange();
          throw error;
        }),
    };
    this.entries.set(key, entry);
    this.onChange();
    pruneMapToMaxSize(this.entries, CACHE_LIMIT);
    // Each visible transcript or popup owns its subscription, not the shared fetch.
    return subscribeToSharedRequest(entry, {}, signal);
  }
}
