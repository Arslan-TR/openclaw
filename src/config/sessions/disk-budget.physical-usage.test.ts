import { channel } from "node:diagnostics_channel";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
  withSessionHistoryBudgetSweepsForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { withRuntimeWorkerGeneration } from "../../infra/runtime-worker-generation.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import * as storeWriterQueue from "../../shared/store-writer-queue.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { drainSessionDiskBudgetWorkers } from "./disk-budget-runtime.js";
import {
  hasRetainedSessionTranscriptArchives,
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
} from "./disk-budget.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const workers: Worker[] = [];
const workerChannel = channel("worker_threads");
const trackWorker = (message: unknown) => workers.push((message as { worker: Worker }).worker);

beforeEach(() => workerChannel.subscribe(trackWorker));
afterEach(async () => {
  workerChannel.unsubscribe(trackWorker);
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const expectedUsage = (sessionFilesBytes: number, databaseWalBytes = 654) => ({
  databaseMainBytes: 321,
  databaseWalBytes,
  sessionFilesBytes,
  totalBytes: 321 + databaseWalBytes + sessionFilesBytes,
});
const archiveName = "old.jsonl.deleted.2026-01-01T00-00-00.000Z.zst";

async function withDatabase(run: (storePath: string, directory: string) => Promise<void>) {
  await withTestDir({ prefix: "openclaw-disk-usage-" }, async (directory) => {
    const storePath = path.join(directory, "openclaw-agent.sqlite");
    await fs.writeFile(storePath, Buffer.alloc(321));
    await run(storePath, directory);
  });
}

function interceptScans(
  intercept: (input: unknown, run: (input: unknown) => Promise<unknown>) => Promise<unknown>,
) {
  const original = WorkerTaskPool.prototype.run;
  return vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
    this: WorkerTaskPool<unknown, unknown>,
    input,
    options,
  ) {
    return intercept(input, (prepared) => original.call(this, prepared, options));
  });
}

const afterRelease = async (release: Deferred, input: unknown) => {
  await release.promise;
  return input;
};

function holdRetirement(worker: Worker, entered: Deferred) {
  const release = createDeferredCore();
  const terminate = worker.terminate.bind(worker);
  const spy = vi.spyOn(worker, "terminate").mockImplementationOnce(async () => {
    const code = await terminate();
    entered.resolve();
    await release.promise;
    return code;
  });
  return { release, spy };
}

async function addSessionArtifacts(directory: string, index: number): Promise<void> {
  const hash = index.toString(16).padStart(64, "0");
  const blobDirectory = path.join(directory, "skills-prompts", "sha256", hash.slice(0, 2));
  await fs.mkdir(blobDirectory, { recursive: true });
  await fs.writeFile(path.join(directory, `session-${index}.jsonl`), Buffer.alloc(7));
  await fs.writeFile(path.join(blobDirectory, `${hash}.txt`), Buffer.alloc(11));
}

describe("physical session disk usage", () => {
  it.each([false, true])(
    "joins a forced followup after maintenance failure (mutation fails: %s)",
    async (mutationFails) => {
      await withDatabase(async (storePath) => {
        const failure = new Error("synthetic first scan preparation failure");
        const mutationFailure = new Error("synthetic mutation failure");
        const releaseFirst = createDeferredCore();
        const followupEntered = createDeferredCore();
        const releaseFollowup = createDeferredCore();
        const scans: Promise<unknown>[] = [];
        let followupFinished = false;
        const spy = interceptScans((input, invoke) => {
          const first = scans.length === 0;
          const result = invoke(async () => {
            if (first) {
              await releaseFirst.promise;
              throw failure;
            }
            followupEntered.resolve();
            await releaseFollowup.promise;
            return input;
          });
          const completion = first
            ? result
            : result.finally(() => {
                followupFinished = true;
              });
          scans.push(completion);
          return completion;
        });
        const maintenanceConfig = resolveMaintenanceConfigFromInput({
          mode: "enforce",
          maxDiskBytes: 1024 * 1024,
          highWaterBytes: 512 * 1024,
        });
        const operation = withSessionHistoryBudgetSweepsForTest(async () => {
          kickSessionHistoryDiskBudgetMaintenance({ storePath, maintenanceConfig });
          kickSessionHistoryDiskBudgetMaintenance({ storePath, maintenanceConfig, force: true });
          releaseFirst.resolve();
          if (mutationFails) {
            throw mutationFailure;
          }
        });
        const outcome = operation.then(
          () => ({ error: undefined, followupFinished }),
          (error: unknown) => ({ error, followupFinished }),
        );
        try {
          await followupEntered.promise;
          releaseFollowup.resolve();
          const result = await outcome;
          if (mutationFails) {
            expect(result.error).toBeInstanceOf(AggregateError);
            expect(result.error).toHaveProperty("errors", [mutationFailure, failure]);
          } else {
            expect(result.error).toBe(failure);
          }
          expect(result.followupFinished, "Join already-started followup work").toBe(true);
          expect(scans).toHaveLength(2);
        } finally {
          releaseFirst.resolve();
          releaseFollowup.resolve();
          await outcome;
          await Promise.allSettled(scans);
          spy.mockRestore();
          await drainSessionDiskBudgetWorkers();
        }
      });
    },
  );

  it("joins real SDK mutation maintenance before native fixture drainage", async () => {
    const state = await createOpenClawTestState({ layout: "state-only" });
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const scope = { agentId: "main", env: state.env, storePath, sessionKey: "agent:main:fixture" };
    const releasePreparation = createDeferredCore();
    const mutationBodyFinished = createDeferredCore<boolean>();
    const secondScanAdmitted = createDeferredCore();
    const nativeRetired = createDeferredCore();
    let scans = 0;
    const scanSpy = interceptScans((input, invoke) => {
      if (input !== storePath) {
        return invoke(input);
      }
      const scan = ++scans;
      const result = invoke(scan === 1 ? () => afterRelease(releasePreparation, input) : input);
      if (scan === 2) {
        secondScanAdmitted.resolve();
      }
      return result;
    });
    let retirement: ReturnType<typeof holdRetirement> | undefined;
    const diskWorkerUrl = resolveRuntimeProcessEntrypointUrl("sessionDiskBudget");
    const stateReadUrl = resolveRuntimeProcessEntrypointUrl("stateRead");
    const ownedStateReadPath = state.path("sdk-drainage-state-read.mjs");
    await fs.writeFile(ownedStateReadPath, `export * from ${JSON.stringify(stateReadUrl.href)};\n`);
    const ownedStateReadUrl = pathToFileURL(ownedStateReadPath);
    const createWorker = workerCpu.createCpuTrackedWorker;
    const workerCreation = vi
      .spyOn(workerCpu, "createCpuTrackedWorker")
      .mockImplementation((filename, options) => {
        const worker = createWorker(filename, options);
        if (!retirement && String(filename) === diskWorkerUrl.href) {
          retirement = holdRetirement(worker, nativeRetired);
        }
        return worker;
      });
    await withRuntimeWorkerGeneration(async (bind) => {
      // Only the shared-state helper joins this generation; disk scans keep their own drain.
      bind((url) => (url.href === stateReadUrl.href ? ownedStateReadUrl : url));
      const mutation = withSessionHistoryBudgetSweepsForTest(async () => {
        try {
          await upsertSessionEntry({
            ...scope,
            entry: { sessionId: "fixture-session", updatedAt: Date.now() },
          });
          expect(await deleteSessionEntry({ ...scope, expectedSessionId: "fixture-session" })).toBe(
            true,
          );
          const sweeps = vi.mocked(storeWriterQueue.runQueuedStoreWrite).mock.calls;
          expect(
            sweeps.some(([params]) => params.label === "enforceSqliteSessionHistoryDiskBudget"),
            "SDK mutations must reach the observed queue",
          ).toBe(true);
          expect(scans).toBe(1);
          mutationBodyFinished.resolve(true);
        } catch (error) {
          mutationBodyFinished.resolve(false);
          throw error;
        }
      });
      let drainage: Promise<void> | undefined;
      try {
        if (!(await mutationBodyFinished.promise)) {
          releasePreparation.resolve();
          await mutation;
        }
        drainage = (async () => {
          await mutation;
          await drainSessionDiskBudgetWorkers();
        })();
        releasePreparation.resolve();
        await Promise.all([nativeRetired.promise, secondScanAdmitted.promise]);
        retirement?.release.resolve();
        await drainage;
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        expect(scans).toBe(2);
      } finally {
        releasePreparation.resolve();
        retirement?.release.resolve();
        await Promise.allSettled([mutation, drainage]);
        retirement?.spy.mockRestore();
        workerCreation.mockRestore();
        scanSpy.mockRestore();
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        await drainSessionDiskBudgetWorkers();
      }
    }, state.cleanup);
    const liveThreadIds = workers.map((worker) => worker.threadId).filter((id) => id !== -1);
    expect(liveThreadIds, "SDK fixture drainage must leave no live native worker").toEqual([]);
  });

  it("joins a measurement admitted after drainage starts before retiring its worker", async () => {
    await withDatabase(async (storePath) => {
      const release = createDeferredCore();
      const spy = interceptScans((input, invoke) => {
        spy.mockRestore();
        return invoke(() => afterRelease(release, input));
      });
      let completed = 0;
      const first = measureSessionPhysicalDiskUsage(storePath).then(() => completed++);
      const drainage = drainSessionDiskBudgetWorkers();
      const late = measureSessionPhysicalDiskUsage(storePath).then(() => completed++);
      try {
        release.resolve();
        await drainage;
        expect(completed).toBe(2);
        expect(workers.length).toBeGreaterThan(0);
        expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
      } finally {
        release.resolve();
        spy.mockRestore();
        await Promise.allSettled([first, late, drainage]);
        await drainSessionDiskBudgetWorkers();
      }
    });
  });

  it.each([
    { owner: "file teardown", drain: drainSessionDiskBudgetWorkers },
    { owner: "runtime lifecycle cleanup", drain: drainGlobalSingletonLifecycleState },
  ])(
    "coalesces $owner with another teardown while a runtime scan awaits retirement",
    async ({ drain }) => {
      await withDatabase(async (storePath) => {
        await measureSessionPhysicalDiskUsage(storePath);
        const retiringWorker = workers[0]!;
        const entered = createDeferredCore();
        // Observe the worker being drained; other pools may retire workers concurrently.
        const { release, spy: retirement } = holdRetirement(retiringWorker, entered);
        const firstDrain = drain();
        let secondDrain: Promise<void> | undefined;
        let measurement: ReturnType<typeof measureSessionPhysicalDiskUsage> | undefined;
        try {
          await entered.promise;
          let measured = false;
          measurement = measureSessionPhysicalDiskUsage(storePath).then((usage) => {
            measured = true;
            return usage;
          });
          secondDrain = drainSessionDiskBudgetWorkers();
          await nextTurn();
          expect(measured).toBe(false);
          expect(retiringWorker.threadId).toBe(-1);
          release.resolve();
          await Promise.all([firstDrain, secondDrain]);
          await expect(measurement).resolves.toMatchObject({ totalBytes: 321 });
          expect(retirement).toHaveBeenCalledTimes(1);
          expect(workers).toHaveLength(2);
          expect(workers[1]?.threadId).toBeGreaterThan(0);
        } finally {
          release.resolve();
          await Promise.allSettled([firstDrain, secondDrain, measurement]);
          retirement.mockRestore();
          await drainSessionDiskBudgetWorkers();
        }
      });
    },
  );

  it("reports scan overload and retires queued scans before reusing workers", async () => {
    await withDatabase(async (storePath, directory) => {
      const archivePath = path.join(directory, archiveName);
      await fs.writeFile(archivePath, Buffer.alloc(100));
      const release = createDeferredCore();
      // Hold every slot so overload is independent of worker startup timing.
      const spy = interceptScans((input, run) => run(() => afterRelease(release, input)));
      let settledScans = 0;
      const accepted = Array.from({ length: 128 }, () =>
        measureSessionPhysicalDiskUsage(storePath).then((usage) => {
          settledScans++;
          return usage;
        }),
      );
      let drainage: Promise<void> | undefined;
      let reported: unknown;
      const excess = measureSessionPhysicalDiskUsage(storePath).catch((error: unknown) => {
        reported = error;
      });
      try {
        await nextTurn();
        expect(reported).toMatchObject({ name: "WorkerTaskError", code: "overloaded" });
        await expect(
          pruneSessionTranscriptArchivesToHighWater({ storePath, highWaterBytes: 321 }),
        ).rejects.toMatchObject({ code: "overloaded" });
        expect((await fs.stat(archivePath)).size).toBe(100);
        let drained = false;
        drainage = drainGlobalSingletonLifecycleState().then(() => {
          drained = true;
        });
        await nextTurn();
        expect(drained).toBe(false);
        release.resolve();
        await drainage;
        expect(settledScans).toBe(128);
        const retiredWorkers = workers.length;
        expect(retiredWorkers).toBeGreaterThan(0);
        expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
        expect(await Promise.all(accepted)).toEqual(
          Array.from({ length: 128 }, () => expectedUsage(100, 0)),
        );
        await expect(
          pruneSessionTranscriptArchivesToHighWater({ storePath, highWaterBytes: 321 }),
        ).resolves.toMatchObject({ removedFiles: 1, usage: { totalBytes: 321 } });
        await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(workers).toHaveLength(retiredWorkers + 1);
        expect(workers.at(-1)?.threadId).toBeGreaterThan(0);
      } finally {
        release.resolve();
        spy.mockRestore();
        await Promise.allSettled([...accepted, excess]);
        await drainage;
      }
    });
  });

  it("measures and prunes the canonical session artifacts through the SQLite selector", async () => {
    await withTestDir({ prefix: "openclaw-disk-selector-" }, async (directory) => {
      const agentDir = path.join(directory, "agents", "main");
      const sessionsDir = path.join(agentDir, "sessions");
      const storePath = path.join(agentDir, "agent", "openclaw-agent.sqlite");
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, Buffer.alloc(321));
      await fs.writeFile(`${storePath}-wal`, Buffer.alloc(654));
      await fs.writeFile(`${storePath}-shm`, Buffer.alloc(32_768));
      await fs.writeFile(path.join(path.dirname(storePath), "unrelated.txt"), Buffer.alloc(13));
      await addSessionArtifacts(sessionsDir, 0);
      const archivePath = path.join(sessionsDir, archiveName);
      await fs.writeFile(archivePath, Buffer.alloc(100));
      await expect(measureSessionPhysicalDiskUsage(storePath)).resolves.toEqual(expectedUsage(118));
      await expect(hasRetainedSessionTranscriptArchives(storePath)).resolves.toBe(true);
      await expect(
        pruneSessionTranscriptArchivesToHighWater({ storePath, highWaterBytes: 993 }),
      ).resolves.toMatchObject({
        removedFiles: 1,
        usage: { sessionFilesBytes: 18, totalBytes: 993 },
      });
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(hasRetainedSessionTranscriptArchives(storePath)).resolves.toBe(false);
    });
  });

  it("does not add synchronous realpath work as session artifacts grow", async () => {
    await withDatabase(async (storePath, directory) => {
      await fs.writeFile(`${storePath}-wal`, Buffer.alloc(654));
      await fs.writeFile(`${storePath}-shm`, Buffer.alloc(32_768));
      await addSessionArtifacts(directory, 0);
      const realpath = vi.spyOn(nodeFs, "realpathSync");
      const fixtureSyncCalls = () =>
        realpath.mock.calls.filter(
          ([candidate]) =>
            typeof candidate === "string" && candidate.startsWith(`${directory}${path.sep}`),
        ).length;
      try {
        const initial = await measureSessionPhysicalDiskUsage(storePath);
        const initialSyncCalls = fixtureSyncCalls();
        expect(initial).toEqual(expectedUsage(18));
        for (let index = 1; index <= 32; index += 1) {
          await addSessionArtifacts(directory, index);
        }
        realpath.mockClear();

        expect(await measureSessionPhysicalDiskUsage(storePath)).toEqual(expectedUsage(33 * 18));
        // Filesystem work that grows with the directory must not block the event loop.
        expect(fixtureSyncCalls()).toBeLessThanOrEqual(initialSyncCalls);
      } finally {
        realpath.mockRestore();
      }
    });
  });
});
