import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessagePort, Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { runWithSqliteDatabaseAdmissionTurn } from "./sqlite-database-admission-turn.js";
import {
  captureSqliteDatabaseAdmissions,
  hasPendingSqliteDatabaseSchemaMutation,
  readSqliteDatabaseAdmissions,
  readSqliteDatabaseWriteRevision,
  readSqliteDatabaseScopedWriteToken,
  retireSqliteDatabaseWriteScopes,
  publishSqliteDatabaseAdmission,
  getSqliteDatabaseAdmission,
} from "./sqlite-database-admission.js";
import type {
  AdmissionTaskInput,
  AdmissionTaskResult,
} from "./sqlite-database-admission.task.test-support.js";
import {
  hostFactKey,
  type AdmissionOperations,
} from "./sqlite-database-admission.worker.test-support.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerReply, SqliteWorkerStore } from "./sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

const cleanups: (() => Promise<void>)[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of cleanups.splice(0).toReversed()) {
      await close();
    }
    cleanup();
  }),
);
const moduleUrl = new URL("./sqlite-database-admission.worker.test-support.ts", import.meta.url);

function fixture(prefix: string, filename = "shared.sqlite", brokerCount = 1) {
  const root = tempDirs.make(`sqlite-${prefix}-`);
  const location = path.join(root, filename);
  const brokers = Array.from({ length: brokerCount }, () => new SqliteWorkerBroker());
  const databases: DatabaseSync[] = [];
  const open = (databasePath: string, readOnly = false) => {
    const database = openNodeSqliteDatabase(databasePath, { readOnly });
    databases.push(database);
    return database;
  };
  const admitHost: Parameters<typeof createSqliteWorkerOperationAdmission>[0] = (
    _request,
    grant,
  ) => {
    admitSqliteSchema(open(location));
    grant();
  };
  cleanups.push(async () => {
    await Promise.all(brokers.map((broker) => broker.close()));
    databases.forEach((database) => database.close());
  });
  return {
    root,
    location,
    broker: brokers[0]!,
    brokers,
    open,
    run<Key extends keyof AdmissionOperations>(
      store: SqliteWorkerStore<AdmissionOperations>,
      command: { type: Key; input: AdmissionOperations[Key]["input"] },
      admit = admitHost,
    ) {
      return brokers[0]!.runOperation(
        store,
        (scope) => scope.execute(command),
        undefined,
        undefined,
        hostAdmission(location, admit),
      );
    },
  };
}

function tableIsAdmitted(database: DatabaseSync) {
  return getAdmittedSqliteSchemaFacts(database)?.tables.has("worker_publication");
}

function openStore(broker: SqliteWorkerBroker, databasePath: string) {
  return broker.open<AdmissionOperations>({ moduleUrl, databasePath, input: undefined });
}

function hostAdmission(
  location: string,
  admit: Parameters<typeof createSqliteWorkerOperationAdmission>[0],
) {
  return () => ({
    nativeLocations: [location],
    admission: createSqliteWorkerOperationAdmission(admit),
  });
}

function taskPool(retainedTransport = false) {
  const pool = createOwnedWorkerTaskPool<AdmissionTaskInput, AdmissionTaskResult>(
    {
      workerUrl: new URL("./sqlite-database-admission.task.test-support.ts", import.meta.url),
      maxWorkers: 1,
      idleTimeoutMs: 0,
    },
    retainedTransport ? { retainedTransport: true } : undefined,
  );
  cleanups.push(() => pool.close());
  return pool;
}

function readerWorker(location: string, program: string) {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { register } = await import(workerData.loader);
      const unregister = register();
      const { openNodeSqliteDatabase } = await import(workerData.native);
      ${program}
      parentPort.close();
    })().catch((error) => { throw error; });
  `,
    {
      eval: true,
      execArgv: [],
      workerData: {
        location,
        key: hostFactKey.name,
        loader: import.meta.resolve("tsx/esm/api"),
        native: new URL("./node-sqlite.ts", import.meta.url).href,
        admission: new URL("./sqlite-database-admission.ts", import.meta.url).href,
        schema: new URL("./sqlite-schema-facts.ts", import.meta.url).href,
      },
    },
  );
  cleanups.push(async () => {
    await worker.terminate();
  });
  return worker;
}

it("settles worker facts through admission without echoing snapshots in ordinary replies", async () => {
  const { location, broker, open } = fixture("admission-reply");
  const database = open(location);
  const replies: SqliteWorkerReply[] = [];
  const workerFact = { ...hostFactKey, name: "admission-test-worker-value" };
  let factAtReply: number | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the emitting worker.
  const originalEmit = Worker.prototype.emit;
  vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
  ) {
    if (event === "message" && reply.ok) {
      replies.push(reply);
      factAtReply = getSqliteDatabaseAdmission(database, workerFact);
    }
    return Reflect.apply(originalEmit, this, [event, reply]);
  });
  const store = await openStore(broker, location);
  for (const value of [1, 2]) {
    publishSqliteDatabaseAdmission(database, hostFactKey, value);
    await store!.execute({ type: "admitted", input: { measureHostAbsence: true } });
    // The host receives the new worker fact before the broker sees the ordinary reply.
    expect(factAtReply).toBe(1);
  }
  await store!.close();
  expect(replies).toHaveLength(4);
  for (const reply of replies) {
    expect(reply).not.toHaveProperty("databaseAdmissions");
  }
});

it("bootstraps complete host facts before any exchange", async () => {
  const { location, open } = fixture("bootstrap-host-facts");
  const database = open(location);
  publishSqliteDatabaseAdmission(database, hostFactKey, 42);
  const worker = readerWorker(
    location,
    `
      const { getSqliteDatabaseAdmission, withSqliteDatabaseAdmissionExchange } =
        await import(workerData.admission);
      const database = openNodeSqliteDatabase(workerData.location, { readOnly: true });
      const key = { name: workerData.key, writer: "host", read: (value) => value };
      let exchanges = 0;
      const facts = withSqliteDatabaseAdmissionExchange(() => {
        exchanges += 1;
        return [];
      }, () => ({
        absent: getSqliteDatabaseAdmission(database, { ...key, name: key.name + "-absent" }),
        value: getSqliteDatabaseAdmission(database, key),
      }));
      database.close();
      unregister();
      parentPort.postMessage({ ...facts, exchanges });
  `,
  );
  const [[facts], [code]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
  expect(code).toBe(0);
  expect(facts).toEqual({ absent: undefined, value: 42, exchanges: 0 });
});

it("joins host admission created after a worker's operation context before its first DDL", async () => {
  const { root, location, broker, open, run } = fixture("late-host-admission", "target.sqlite");
  createDatabase(location, 1);
  let reader: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  const store = await openStore(broker, path.join(root, "control.sqlite"));
  expect(
    await run(
      store!,
      { type: "mutateAfterHostAdmission", input: { path: location } },
      (_request, grant) => {
        reader = open(location, true);
        admitSqliteSchema(reader);
        expect(tableIsAdmitted(reader)).toBe(false);
        grant();
      },
    ),
  ).toEqual({ native: true, admitted: true });
  const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    expect(tableIsAdmitted(reader!)).toBe(true);
    expect(observation.queries).toEqual([]);
  } finally {
    observation.restore();
  }
});

it("settles scoped writes without host metadata round trips after peer registrations", async () => {
  const { location, broker, open, run } = fixture("scoped-receipts");
  const database = open(location);
  database.exec("CREATE TABLE original(value)");
  admitSqliteSchema(database);
  const store = await openStore(broker, location);
  const token = (key: string) => readSqliteDatabaseScopedWriteToken(database, key);
  const predecessor = store!.execute({ type: "admitted", input: undefined });
  let first = token("first");
  const second = token("second");
  let current = true;
  const refused = new Error("Queued scope lost authority");
  const rejected = broker.runOperation(
    store!,
    (scope) =>
      scope.execute({ type: "writeRows", input: { sql: "INSERT INTO original VALUES (-1)" } }),
    undefined,
    () => {
      if (!current) {
        throw refused;
      }
    },
  );
  current = false;
  const outcomes = await Promise.allSettled([predecessor, rejected]);
  expect(outcomes[0]!.status).toBe("fulfilled");
  expect(outcomes[1]).toEqual({ status: "rejected", reason: refused });
  // A new publication must not acknowledge scopes captured by a refused dispatch.
  token("after-rejection");
  await store!.execute({
    type: "writeRows",
    input: { sql: "INSERT INTO original VALUES (2)", sessionKeys: ["second"] },
  });
  expect(token("first")).toBe(first);
  expect(token("second")).not.toBe(second);
  let secondCommitted = token("second");

  const writeAfterPublication = (value: number, sessionKey: string, publish: () => void) =>
    run(
      store!,
      {
        type: "writeRows",
        input: {
          sql: `INSERT INTO original VALUES (${value})`,
          sessionKeys: [sessionKey],
          awaitPublication: true,
        },
      },
      (request, grant) => {
        if (request.stage === "transaction") {
          publish();
        }
        grant();
      },
    );

  // Publish after dispatch: unknown scopes invalidate broadly, known scopes settle exactly,
  // and retiring a known cell invalidates its replacement incarnation too.
  for (const [value, writeKey, publishedKey, retire, preserved] of [
    [3, "late", "late", false, false],
    [5, "second", "unrelated", false, true],
    [6, "second", "second", true, false],
  ] as const) {
    let published: string | undefined;
    expect(
      await writeAfterPublication(value, writeKey, () => {
        if (retire) {
          retireSqliteDatabaseWriteScopes(database, [publishedKey]);
        }
        published = token(publishedKey);
      }),
    ).toEqual({ lookupMessages: 0 });
    expect(published).toBeTypeOf("string");
    expect(token(publishedKey) === published).toBe(preserved);
    expect(token("first") === first).toBe(preserved);
    expect(token("second")).not.toBe(secondCommitted);
    first = token("first");
    secondCommitted = token("second");
  }

  await store!.execute({ type: "writeRows", input: { sql: "INSERT INTO original VALUES (4)" } });
  expect(token("first")).not.toBe(first);
  expect(token("second")).not.toBe(secondCommitted);
  expect(database.prepare("SELECT value FROM original ORDER BY value").all()).toEqual(
    [2, 3, 4, 5, 6].map((value) => ({ value })),
  );
});
it("keeps one shared generation when the host opens a newly created worker database before publication", async () => {
  const { location, broker, open } = fixture("created-generation", "created.sqlite");
  let reader: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  const store = await broker.open<AdmissionOperations>(
    { moduleUrl, databasePath: location, input: { hostBeforeAdmission: true } },
    undefined,
    undefined,
    {
      createAdmission: hostAdmission(location, (request, grant) => {
        if (request.stage === "prepare") {
          reader = open(location, true);
        }
        grant();
      }),
    },
  );
  expect(reader).toBeDefined();
  admitSqliteSchema(reader!);
  expect(tableIsAdmitted(reader!)).toBe(false);
  await store!.execute({ type: "mutate", input: undefined });
  expect(tableIsAdmitted(reader!)).toBe(true);
});

function createDatabase(location: string, value: number): void {
  const database = new DatabaseSync(location);
  try {
    database.exec("CREATE TABLE proof (value INTEGER NOT NULL)");
    database.prepare("INSERT INTO proof VALUES (?)").run(value);
  } finally {
    database.close();
  }
}

it("keeps per-operation admission replies scoped to the requested database", async () => {
  const { root, location, broker, open, run } = fixture("admission-fleet", "target.sqlite");
  createDatabase(location, 42);
  const store = await openStore(broker, path.join(root, "control.sqlite"));
  const unrelated = Array.from({ length: 3 }, (_, index) =>
    path.join(root, `unrelated-${index}.sqlite`),
  );
  for (const filename of unrelated) {
    createDatabase(filename, 0);
    const database = open(filename);
    admitSqliteSchema(database);
  }
  const replies: string[][] = [];
  // oxlint-disable-next-line typescript/unbound-method -- call restores the sending port below.
  const postMessage = MessagePort.prototype.postMessage;
  vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
    this: MessagePort,
    message: unknown,
    transferList,
  ) {
    const admissions = readSqliteDatabaseAdmissions(message);
    if (admissions) {
      replies.push(admissions.map((record) => record.location));
    }
    return postMessage.call(this, message, transferList);
  });
  const result = await run(store!, {
    type: "read",
    input: { path: location, awaitPublication: true },
  });
  expect(result).toMatchObject({ values: [42], sql: [] });
  expect(replies.flat()).toContain(location);
  expect(replies.flat().filter((filename) => unrelated.includes(filename))).toEqual([]);
});

it("publishes through a retained physical database after its original pathname is replaced", async () => {
  const { root, location, broker, open } = fixture("retained-admission", "original.sqlite");
  const retainedPath = path.join(root, "retained.sqlite");
  const replacementPath = path.join(root, "replacement.sqlite");
  createDatabase(location, 42);
  const reader = open(location);
  admitSqliteSchema(reader);
  linkSync(location, retainedPath);
  // The worker's own filename stays valid; only the shared admission's first pathname changes.
  const store = await openStore(broker, retainedPath);
  createDatabase(replacementPath, 99);
  renameSync(replacementPath, location);
  const revision = readSqliteDatabaseWriteRevision(reader);
  expect(revision).toBeTypeOf("number");
  await store!.execute({ type: "writeRows", input: { sql: "UPDATE proof SET value=43" } });
  const updatedRevision = readSqliteDatabaseWriteRevision(reader);
  expect(updatedRevision).toBeTypeOf("number");
  expect(updatedRevision).not.toBe(revision);
  expect(reader.prepare("SELECT value FROM proof").get()).toEqual({ value: 43 });
  await store!.execute({ type: "mutate", input: undefined });
  expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(false);
  expect(tableIsAdmitted(reader)).toBe(true);
  const replacement = open(location, true);
  admitSqliteSchema(replacement);
  expect(tableIsAdmitted(replacement)).toBe(false);
  expect(replacement.prepare("SELECT value FROM proof").get()).toEqual({ value: 99 });
});
it("preserves a sibling writer's POSIX lock when an unhosted worker retires", async () => {
  const location = path.join(tempDirs.make("sqlite-unhosted-lock-"), "shared.sqlite");
  createDatabase(location, 1);
  const writer = new DatabaseSync(location);
  writer.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
  const worker = readerWorker(
    location,
    `
      const { admitSqliteSchema } = await import(workerData.schema);
      const database = openNodeSqliteDatabase(workerData.location, { readOnly: true });
      admitSqliteSchema(database);
      database.close();
      unregister();
  `,
  );
  try {
    await once(worker, "exit");
    const outcome = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      try {
        db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK");
        process.stdout.write("unlocked");
      } catch (error) {
        if ((error.errcode & 255) !== 5) throw error;
        process.stdout.write("busy");
      } finally { db.close(); }
    `,
        location,
      ],
      { encoding: "utf8" },
    );
    expect(outcome).toBe("busy");
  } finally {
    await worker.terminate();
    writer.exec("ROLLBACK");
    writer.close();
  }
});

it("shares admission published after dispatch with existing isolates and revalidates replaced files", async () => {
  const { root, location, brokers, run } = fixture("admission-workers", "shared.sqlite", 2);
  createDatabase(location, 42);
  const stores = await Promise.all(
    ["first", "second"].map(async (name, index) => {
      const databasePath = path.join(root, `${name}.sqlite`);
      createDatabase(databasePath, 0);
      return openStore(brokers[index]!, databasePath);
    }),
  );
  const [first, second] = stores;
  const firstRead = await run(first!, {
    type: "read",
    input: { path: location, awaitPublication: true },
  });
  const secondRead = await second!.execute({ type: "read", input: { path: location } });
  const reopened = await first!.execute({ type: "read", input: { path: location } });
  expect(firstRead.threadId).not.toBe(secondRead.threadId);
  for (const read of [firstRead, secondRead, reopened]) {
    expect(read).toMatchObject({ values: [42], sql: [] });
  }
  expect(
    await run(first!, { type: "hostFacts", input: { path: location } }, (_request, grant) => {
      const database = openNodeSqliteDatabase(location);
      try {
        publishSqliteDatabaseAdmission(database, hostFactKey, 42);
      } finally {
        database.close();
      }
      grant();
    }),
  ).toEqual({ value: 42, lookupMessages: 0 });

  renameSync(location, path.join(root, "old.sqlite"));
  createDatabase(location, 43);
  const replacement = await second!.execute({ type: "read", input: { path: location } });
  expect(replacement.values).toEqual([43]);
  expect(replacement.sql.length).toBeGreaterThan(0);
  const sharedReplacement = await first!.execute({ type: "read", input: { path: location } });
  expect(sharedReplacement).toMatchObject({ values: [43], sql: replacement.sql });

  const holder = openNodeSqliteDatabase(location);
  admitSqliteSchema(holder);
  const replacementRecord = captureSqliteDatabaseAdmissions().findLast(
    (record) => record.location === location,
  )!;
  holder.close();
  await second!.execute({ type: "retirePath", input: { path: location } });
  const readmitted = openNodeSqliteDatabase(location, { readOnly: true });
  const sibling = openNodeSqliteDatabase(location, { readOnly: true });
  try {
    admitSqliteSchema(readmitted);
    admitSqliteSchema(sibling);
    expect(getAdmittedSqliteSchemaFacts(sibling)?.admissionId).toBe(
      getAdmittedSqliteSchemaFacts(readmitted)?.admissionId,
    );
  } finally {
    readmitted.close();
    sibling.close();
  }
  await second!.execute({ type: "retirePath", input: { path: location } });
  expect(
    captureSqliteDatabaseAdmissions().some(
      (record) => record.identity === replacementRecord.identity,
    ),
  ).toBe(false);
});

it("serializes simultaneous first admissions across independent worker brokers", async () => {
  const { location, brokers } = fixture("first-admission", "shared.sqlite", 2);
  createDatabase(location, 1);
  const stores = await Promise.all(brokers.map((broker) => openStore(broker, location)));
  const admissions = await Promise.all(
    stores.map((store) => store!.execute({ type: "admitted", input: undefined })),
  );
  expect(new Set(admissions.map((result) => result.threadId)).size).toBe(2);
  expect(admissions.filter((result) => result.sql.length > 0)).toHaveLength(1);
  expect(admissions.some((result) => result.sql.some((sql) => sql.includes("sqlite_schema")))).toBe(
    true,
  );
});

it("shares facts with retained task workers across awaited host exchanges", async () => {
  const { root, location, open } = fixture("admission-tasks");
  createDatabase(location, 1);
  const pools = Array.from({ length: 2 }, () => taskPool(true));
  const ready = await Promise.all(pools.map((pool) => pool.run({}, {})));
  expect(new Set(ready.map((result) => result.threadId)).size).toBe(2);
  const first = await pools[0]!.run(
    { path: location, awaitPublication: true },
    {
      async onRequest() {
        const retained = open(location);
        admitSqliteSchema(retained);
        return { input: undefined, timeoutMs: 300_000 };
      },
    },
  );
  const second = await pools[1]!.run({ path: location }, {});
  expect([first.sql, second.sql]).toEqual([[], []]);

  const discovered = path.join(root, "new-sibling.sqlite");
  createDatabase(discovered, 2);
  const family = runWithSqliteDatabaseAdmissionTurn(
    [],
    () => pools[0]!.run({ path: discovered }, {}),
    [root],
  );
  const exact = runWithSqliteDatabaseAdmissionTurn([discovered], () =>
    pools[1]!.run({ path: discovered }, {}),
  );
  const [firstAdmission, reused] = await Promise.all([family, exact]);
  expect(firstAdmission.sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
  // The first task may close its final handle before the second opens.
  expect([[], firstAdmission.sql]).toContainEqual(reused.sql);

  const nestedLocation = path.join(root, "nested.sqlite");
  createDatabase(nestedLocation, 3);
  const nested = await pools[0]!.run(
    { path: nestedLocation, nested: true, measureHostAbsence: true },
    {},
  );
  expect(nested.threadId).not.toBe(ready[0]!.threadId);
  expect(nested.sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
  expect(nested.hostLookupMessages).toBe(0);
  const afterNested = await pools[1]!.run({ path: nestedLocation }, {});
  expect(afterNested.sql).toEqual(nested.sql);

  const missing = path.join(root, "unadmitted.sqlite");
  await expect(pools[0]!.run({ path: missing }, {})).rejects.toThrow(/host authority/);
  expect(existsSync(missing)).toBe(false);

  const nestedCreated = path.join(root, "nested-created.sqlite");
  const created = await pools[0]!.run({ path: nestedCreated, nested: true, broker: true }, {});
  expect(existsSync(nestedCreated)).toBe(true);
  expect(created.sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
  const afterCreation = await pools[1]!.run({ path: nestedCreated }, {});
  expect(afterCreation.sql).toEqual(created.sql);

  const captured = path.join(root, "captured.sqlite");
  const uncaptured = path.join(root, "uncaptured.sqlite");
  await expect(
    pools[0]!.run({ path: captured, nested: true, broker: true, creationPath: uncaptured }, {}),
  ).rejects.toThrow("SQLite admission facts exchange failed");
  expect([existsSync(captured), existsSync(uncaptured)]).toEqual([false, false]);
});

it("keeps 5,000 task messages bounded while unrelated session receipts change", async () => {
  const { location, open } = fixture("task-payload", "unrelated.sqlite");
  const database = open(location);
  const pool = taskPool();
  let taskMessages = 0;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the actual worker receiver.
  const postMessage = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker["postMessage"]>
  ) {
    const message: unknown = args[0];
    if (typeof message === "object" && message !== null && "taskId" in message) {
      const payload = JSON.stringify(message, (_key, value: unknown) =>
        value instanceof Map || value instanceof Set
          ? [...value]
          : value instanceof SharedArrayBuffer
            ? [...new Uint8Array(value)]
            : value,
      );
      expect(Buffer.byteLength(payload)).toBeLessThan(16 * 1024);
      taskMessages += 1;
    }
    Reflect.apply(postMessage, this, args);
  });
  readSqliteDatabaseScopedWriteToken(
    database,
    Array.from({ length: 5_000 }, (_, index) => `session-${index}`),
  );
  for (let index = 0; index < 5_000; index += 1) {
    publishSqliteDatabaseAdmission(database, hostFactKey, index);
    await pool.run({}, {});
  }
  expect(taskMessages).toBe(5_000);
});
