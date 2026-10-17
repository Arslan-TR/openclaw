import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.test-support.js";
import { isOutboundDeliveryError, PlatformMessageNotDispatchedError } from "./deliver-types.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { collectEntrySpoolPaths, stageQueuePayloadMedia } from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  claimDeliveryPlatformSendAttempt,
  reserveDeliveryAttempt,
  enqueueDeliveryOnce,
} from "./delivery-queue-storage.js";
import {
  loadPendingDeliveries,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

type DeliveryParams = Parameters<typeof deliverOutboundPayloads>[0];
type MatrixParams = Partial<Omit<DeliveryParams, "cfg" | "channel" | "to">>;

describe("durable outbound queue delivery", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const deliveryIntentId = "cron-direct-delivery:v1:test";
  let tmpDir: string;
  let sendMatrix: ReturnType<typeof vi.fn>;

  const queueStatus = (id = deliveryIntentId) =>
    getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir);
  const pending = () => loadPendingDeliveries(tmpDir);
  const pendingEntry = async () => (await pending())[0];
  const matrixRequest = (params: MatrixParams = {}): DeliveryParams => ({
    cfg: {},
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "hello" }],
    deps: { matrix: sendMatrix },
    queuePolicy: "required",
    ...params,
  });
  const stableRequest = (params: MatrixParams = {}) =>
    matrixRequest({
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
      ...params,
    });
  const deliverMatrix = (params: MatrixParams = {}) =>
    deliverOutboundPayloads(matrixRequest(params));
  const deliverStable = (params: MatrixParams = {}) =>
    deliverOutboundPayloads(stableRequest(params));
  const enqueueMatrix = (
    params: Omit<Parameters<typeof enqueueDeliveryOnce>[0], "channel" | "to">,
    id = deliveryIntentId,
    mediaStageId?: string,
  ) =>
    enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
        ...params,
      },
      id,
      tmpDir,
      mediaStageId,
    );
  const recoveryDelivery = () =>
    vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );
  const drain = (deliver: DeliverFn) => drainMatrixReconnect({ deliver, stateDir: tmpDir });

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });
  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    sendMatrix = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("never lets startup or reconnect impersonate a permanent live producer", async () => {
    await enqueueMatrix({
      payloads: [{ text: "the original permanent producer owns this send" }],
      completionRetention: "permanent",
      requiresProducerClaim: true,
      maxRetries: 1,
    });
    const producerClaimId = await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir);
    assert.ok(producerClaimId, "permanent live producer must claim the stable row");
    await reserveDeliveryAttempt(deliveryIntentId, 1, tmpDir, producerClaimId);
    const deliver = vi.fn<DeliverFn>(async () => []);
    await drain(deliver);
    await recoverPendingDeliveries({
      cfg: {},
      deliver,
      log: createRecoveryLog(),
      stateDir: tmpDir,
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(await pendingEntry()).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "producer_claimed",
      producerClaimId,
      attemptCount: 1,
    });
  });

  it("retains permanent receipts when stable delivery is intentionally suppressed", async () => {
    await expect(
      deliverStable({ payloads: [{ text: "" }], completionRetention: "permanent" }),
    ).resolves.toEqual([]);
    expect(queueStatus()).toBe("completed");
    const recoveryIntentId = "permanent-matrix-suppressed-recovery";
    await enqueueMatrix(
      {
        payloads: [{ text: "" }],
        completionRetention: "permanent",
      },
      recoveryIntentId,
    );
    await drain(vi.fn<DeliverFn>(async () => []));
    expect(queueStatus(recoveryIntentId)).toBe("completed");
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it.each(["live", "recovered"] as const)(
    "never completes %s Matrix batches when any platform send lacks an identity",
    async (mode) => {
      sendMatrix.mockResolvedValueOnce({ messageId: "confirmed" }).mockResolvedValueOnce({});
      const payloads = [{ text: "confirmed recipient message" }, { text: "ambiguous message" }];
      const params = stableRequest({ payloads });
      const deliver = recoveryDelivery();
      const attempt = () => (mode === "live" ? deliverOutboundPayloads(params) : drain(deliver));
      if (mode === "recovered") {
        await enqueueMatrix({ payloads });
      }
      const expectAttempt = async (replay: boolean) => {
        if (mode === "recovered") {
          await attempt();
        } else {
          await expect(attempt()).rejects.toThrow(
            replay
              ? `Stable delivery intent is already queued: ${deliveryIntentId}`
              : "platform send returned no delivery identity for part of the delivery batch",
          );
        }
      };
      await expectAttempt(false);
      expect(sendMatrix).toHaveBeenCalledTimes(2);
      expect(await pendingEntry()).toMatchObject({
        id: deliveryIntentId,
        recoveryState: "unknown_after_send",
        retryCount: 1,
      });
      expect(queueStatus()).toBe("pending");
      await expectAttempt(true);
      expect(sendMatrix).toHaveBeenCalledTimes(2);
      expect(queueStatus()).not.toBe("completed");
    },
  );

  it("reuses durable Matrix media after regenerated producer files disappear", async () => {
    const originalSource = path.join(tmpDir, "original.ogg");
    const originalBytes = "original durable Matrix attachment";
    await fs.writeFile(originalSource, originalBytes);
    const staged = await stageQueuePayloadMedia({
      payloads: [{ text: "original queue-owned caption", mediaUrl: originalSource }],
      mediaAccess: { localRoots: [tmpDir] },
      maxBytes: 1024 * 1024,
      stateDir: tmpDir,
    });
    assert.ok(staged.status === "staged", "original media must be durably staged");
    const spoolPath = staged.artifacts[0];
    assert.ok(spoolPath, "original media must have a queue-owned spool artifact");
    await enqueueMatrix({ payloads: staged.payloads }, deliveryIntentId, staged.mediaStageId);
    const queuedEntry = await pendingEntry();
    expect(
      collectEntrySpoolPaths(
        queuedEntry
          ? acceptedPreparedOutboundEntries(queuedEntry.preparedBatch).map((entry) => entry.payload)
          : [],
        tmpDir,
      ),
    ).toEqual([spoolPath]);
    await fs.rm(originalSource);
    let deliveredBytes: string | undefined;
    sendMatrix.mockImplementation(
      async (_to: string, _text: string, options?: Record<string, unknown>) => {
        assert.ok(
          typeof options?.mediaUrl === "string",
          "Matrix must receive the staged attachment",
        );
        deliveredBytes = await fs.readFile(options.mediaUrl, "utf8");
        return { messageId: "staged-media" };
      },
    );
    await expect(
      deliverStable({
        payloads: [
          {
            text: "regenerated caption must never replace queue custody",
            mediaUrl: path.join(tmpDir, "missing-regenerated.ogg"),
          },
        ],
      }),
    ).resolves.toMatchObject([{ messageId: "staged-media" }]);
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(sendMatrix).toHaveBeenCalledWith(
      "!room:example",
      "original queue-owned caption",
      expect.objectContaining({ mediaUrl: spoolPath }),
    );
    expect(deliveredBytes).toBe(originalBytes);
    expect(queueStatus()).toBe("completed");
    await expect(fs.stat(spoolPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a completed stable receipt after fully successful best-effort delivery", async () => {
    sendMatrix.mockResolvedValue({ messageId: "stable-best-effort-message" });
    const params = stableRequest({ bestEffort: true, queuePolicy: "best_effort" });
    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "stable-best-effort-message" },
    ]);
    expect(queueStatus()).toBe("completed");
    await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it("holds one live claim while concurrent producers reuse a stable pending intent", async () => {
    const started = createDeferred();
    const sent = createDeferred<{ messageId: string }>();
    sendMatrix.mockImplementation(() => {
      started.resolve();
      return sent.promise;
    });
    const params = stableRequest();
    const first = deliverOutboundPayloads(params);
    await started.promise;
    const recoveryDeliver = vi.fn<DeliverFn>(async () => []);
    await drain(recoveryDeliver);
    expect(recoveryDeliver).not.toHaveBeenCalled();
    expect(sendMatrix).toHaveBeenCalledOnce();
    const concurrentReplay = deliverOutboundPayloads(params);
    expect(sendMatrix).toHaveBeenCalledOnce();
    sent.resolve({ messageId: "concurrent-stable-message" });
    await expect(first).resolves.toMatchObject([{ messageId: "concurrent-stable-message" }]);
    await expect(concurrentReplay).resolves.toEqual([]);
    expect(queueStatus()).toBe("completed");
  });

  it("never acknowledges route-only metadata as a platform message identity", async () => {
    sendMatrix.mockResolvedValue({ messageId: "", toJid: "!route-only:example" });
    const params = stableRequest();
    await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
    expect(queueStatus()).toBe("pending");
    expect(await pendingEntry()).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "unknown_after_send",
    });
    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it("removes an unsent queue intent when the caller cancels after publication", async () => {
    const controller = new AbortController();
    await expect(
      deliverMatrix({
        abortSignal: controller.signal,
        onDeliveryIntent: () =>
          controller.abort(new DOMException("Operator cancelled delivery", "AbortError")),
      }),
    ).rejects.toMatchObject({ message: "Operation aborted", queueCustody: "released" });
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(await pending()).toEqual([]);
  });

  it("retries a stable delivery intent only after a proven pre-dispatch failure", async () => {
    sendMatrix
      .mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("provider disconnected before dispatch", {
          cause: new Error("connect ECONNREFUSED"),
        }),
      )
      .mockResolvedValueOnce({ messageId: "recovered-stable-message" });
    const params = stableRequest();
    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      "provider disconnected before dispatch",
    );
    const entry = await pendingEntry();
    expect(entry).toMatchObject({ id: deliveryIntentId, retryCount: 1 });
    expect(entry?.recoveryState).toBeUndefined();
    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "recovered-stable-message" },
    ]);
    expect(queueStatus()).toBe("completed");
    expect(sendMatrix).toHaveBeenCalledTimes(2);
  });

  it("does not retain a pre-send suppression across an ambiguous crash boundary", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    sendMatrix.mockRejectedValueOnce(new Error("ambiguous provider failure"));
    await expect(
      deliverMatrix({ payloads: [{ text: "NO_REPLY" }, { text: "visible" }] }),
    ).rejects.toThrow("ambiguous provider failure");
    const beforeDrain = await pending();
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]?.recoveryState).toBe("unknown_after_send");
    const deliver = vi.fn<DeliverFn>(async () => {});
    await drain(deliver);
    unsubscribe();
    expect(deliver).not.toHaveBeenCalled();
    expect(auditEvents.map((event) => event.outcome)).toEqual([
      "queued",
      "queued",
      "platform_started",
      "unknown",
      "unknown",
    ]);
    expect(auditEvents.slice(-2).map((event) => event.resultCount)).toEqual([0, 0]);
  });

  it.each(["caller", undefined] as const)(
    "keeps proven pre-connect retry custody with %s (#124279, #100979)",
    async (deliveryRetryOwner) => {
      sendMatrix.mockRejectedValueOnce(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      );
      const failure = await deliverMatrix({ deliveryRetryOwner }).catch(
        (caught: unknown) => caught,
      );
      expect(failure).toMatchObject({ message: expect.stringContaining("ECONNREFUSED") });
      expect(isOutboundDeliveryError(failure) && failure.queueCustody).toBe(
        deliveryRetryOwner === "caller" ? "released" : "held",
      );
      const beforeDrain = await pending();
      expect(beforeDrain).toHaveLength(deliveryRetryOwner === "caller" ? 0 : 1);
      if (deliveryRetryOwner !== "caller") {
        expect(beforeDrain[0]).toMatchObject({
          retryCount: 1,
          lastError: expect.stringContaining("ECONNREFUSED"),
        });
        expect(beforeDrain[0]?.recoveryState).toBeUndefined();
        expect(beforeDrain[0]?.platformSendStartedAt).toBeUndefined();
      }
      sendMatrix = vi.fn().mockResolvedValueOnce({ messageId: "recovered" });
      const deliver = recoveryDelivery();
      await drain(deliver);
      expect(deliver).toHaveBeenCalledTimes(deliveryRetryOwner === "caller" ? 0 : 1);
      expect(sendMatrix).toHaveBeenCalledTimes(deliveryRetryOwner === "caller" ? 0 : 1);
      expect(await pending()).toHaveLength(0);
    },
  );
});
