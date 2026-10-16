import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  assertSqliteIntegrity,
  confirmSqliteFileIntegrity,
  isTerminalSqliteIntegrityError,
  runSqliteIntegrityOperationSync,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "./sqlite-integrity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function withDatabase(sql: string, run: (database: DatabaseSync) => void) {
  const database = new (requireNodeSqlite().DatabaseSync)(":memory:");
  try {
    database.exec(sql);
    run(database);
  } finally {
    database.close();
  }
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
}

function taskOrphans(parent = "task_id", child = "task_id", action = "CASCADE", extra = "") {
  return `PRAGMA foreign_keys = OFF;
    CREATE TABLE task_runs (task_id TEXT PRIMARY KEY, other_id TEXT UNIQUE);
    CREATE TABLE task_delivery_state (
      ${child} TEXT PRIMARY KEY REFERENCES task_runs(${parent}) ON DELETE ${action}
    );
    INSERT INTO task_delivery_state (${child}) VALUES
      ${Array.from({ length: 6 }, (_, index) => `('missing-${index + 1}')`).join(", ")};
    ${extra}`;
}

function childOrphans(rows: string, extra = "", withoutRowid = false) {
  const key = withoutRowid ? "TEXT" : "INTEGER";
  return `PRAGMA foreign_keys = OFF;
    CREATE TABLE parents (id ${key} PRIMARY KEY);
    CREATE TABLE children (id ${key} PRIMARY KEY, parent_id ${key} NOT NULL REFERENCES parents(id))
      ${withoutRowid ? "WITHOUT ROWID" : ""};
    INSERT INTO children (id, parent_id) VALUES ${rows};
    ${extra}`;
}

function expectForeignKeyViolation(
  sql: string,
  expected: RegExp | { name: string } = { name: "SqliteIntegrityError" },
  shadow = false,
) {
  withDatabase(sql, (database) => {
    if (shadow) {
      expect(database.prepare("SELECT * FROM pragma_foreign_key_check").all()).toEqual([]);
    }
    expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
      expected instanceof RegExp ? expected : expect.objectContaining(expected),
    );
  });
}

it("classifies cascade-owned task delivery orphans without admitting writes", () => {
  withDatabase(taskOrphans(), (database) => {
    const failure = caught(() => assertSqliteIntegrity(database, "test database"));
    expect(failure).toMatchObject({
      name: "SqliteRepairableForeignKeyError",
      repair: {
        kind: "task-delivery-orphans",
        relation: "task_delivery_state.task_id",
        parentTable: "task_runs",
        orphanCount: 6,
      },
      message: expect.stringMatching(/foreign_key_check failed.*openclaw doctor --fix/u),
    });
    if (!(failure instanceof Error)) {
      throw new Error("Expected integrity admission to refuse unrepaired rows");
    }
    expect(isTerminalSqliteIntegrityError(failure)).toBe(false);
    expect(database.prepare("SELECT count(*) AS count FROM task_delivery_state").get()).toEqual({
      count: 6,
    });
  });
});

interface OrphanCase extends Partial<Record<"parent" | "child" | "action" | "extra", string>> {
  label: string;
}

it.each<OrphanCase>([
  { label: "non-cascade deletion", action: "NO ACTION" },
  { label: "different parent column", parent: "other_id" },
  { label: "different child column", child: "other_id" },
  {
    label: "unrelated violation beyond the diagnostic sample",
    extra: `CREATE TABLE unrelated (id TEXT REFERENCES task_runs(task_id));
              INSERT INTO unrelated (id) VALUES ('missing');`,
  },
  {
    label: "structural damage alongside otherwise repairable orphans",
    extra: `CREATE TABLE damaged (id INTEGER CHECK (id > 0));
              PRAGMA ignore_check_constraints = ON;
              INSERT INTO damaged (id) VALUES (-1);
              PRAGMA ignore_check_constraints = OFF;`,
  },
])("refuses task delivery violations with $label", ({ parent, child, action, extra }) => {
  expectForeignKeyViolation(taskOrphans(parent, child, action, extra));
});

it("does not classify a component of a composite foreign key as repairable", () => {
  expectForeignKeyViolation(
    `PRAGMA foreign_keys = OFF;
        CREATE TABLE task_runs (task_id TEXT, revision INTEGER, PRIMARY KEY (task_id, revision));
        CREATE TABLE task_delivery_state (
          task_id TEXT PRIMARY KEY, revision INTEGER,
          FOREIGN KEY (task_id, revision) REFERENCES task_runs(task_id, revision) ON DELETE CASCADE
        );
        INSERT INTO task_delivery_state (task_id, revision) VALUES ('missing', 1);`,
  );
});

it.each<[string, string, RegExp, boolean?]>([
  [
    "64-bit rowid ordering",
    childOrphans("(9007199254740993, 99), (1, 99)"),
    /children row 1 references parents \(foreign key 0\); children row 9007199254740993 references parents \(foreign key 0\)/u,
  ],
  [
    "shadowed table-valued pragma",
    childOrphans(
      "(1, 99)",
      `CREATE TABLE pragma_foreign_key_check
        ("table" TEXT NOT NULL, rowid INTEGER, parent TEXT NOT NULL, fkid INTEGER NOT NULL);`,
    ),
    /foreign_key_check failed for test database: children row 1 references parents \(foreign key 0\)/u,
    true,
  ],
  [
    "WITHOUT ROWID",
    childOrphans("('child-1', 'missing-parent')", "", true),
    /foreign_key_check failed for test database: children row without rowid references parents \(foreign key 0\)/u,
  ],
])("reports foreign key violations with %s", (_label, sql, expected, shadow) => {
  expectForeignKeyViolation(sql, expected, shadow);
});

const syncDiagnostics = {
  integrityGateMode: "full",
  integrityGateMs: 4,
  integrityGateOutcome: "healthy",
  integrityCheckSyncMs: 4,
  integrityOutsideCheckMs: 0,
};

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function createTimedDatabase(checkMs: number, foreignKeyViolation = false) {
  const database = new (requireNodeSqlite().DatabaseSync)(":memory:");
  databases.push(database);
  database.exec(childOrphans(`(1, ${foreignKeyViolation ? 2 : 1})`));
  database.exec("INSERT INTO parents VALUES (1)");
  let elapsedMs = 0;
  const advance = (durationMs: number) => {
    elapsedMs += durationMs;
  };
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql === "PRAGMA integrity_check;") {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...parameters) => {
        try {
          return all(...parameters);
        } finally {
          advance(checkMs);
        }
      });
    }
    return statement;
  });
  return { database, advance };
}

it.each([
  { label: "measured zero", checkMs: 0.25, foreignKeyViolation: false, gateMs: 4, syncMs: 0 },
  { label: "failed check", checkMs: 4.75, foreignKeyViolation: true, gateMs: 9, syncMs: 4 },
])(
  "splits a $label without changing the gate outcome or error",
  ({ checkMs, foreignKeyViolation, gateMs, syncMs }) => {
    const { database, advance } = createTimedDatabase(checkMs, foreignKeyViolation);
    const diagnostics: SqliteIntegrityDiagnostics = {};
    let suppliedError: unknown;
    function* operation(): SqliteIntegrityOperation<void> {
      const gate = sqliteIntegrityCheckSteps(database, "timed database", diagnostics);
      const step = gate.next();
      if (step.done) {
        throw new Error("Integrity check did not yield");
      }
      advance(1.75);
      try {
        yield step.value;
      } catch (error) {
        suppliedError = error;
        advance(2.75);
        gate.throw(error);
        return;
      }
      advance(2.75);
      gate.next();
    }

    const failure = caught(() => runSqliteIntegrityOperationSync(operation()));
    if (foreignKeyViolation) {
      expect(failure).toMatchObject({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("foreign_key_check failed for timed database"),
      });
      expect(failure).toBe(suppliedError);
    } else {
      expect(failure).toBeUndefined();
    }
    expect(diagnostics).toEqual({
      integrityGateMode: "full",
      integrityGateMs: gateMs,
      integrityGateOutcome: foreignKeyViolation ? "failed" : "healthy",
      integrityCheckSyncMs: syncMs,
      integrityOutsideCheckMs: gateMs - syncMs,
    });
  },
);

it.each([
  { label: "fractional", checkMs: 4.75, lifetimeMs: 8.75, outcome: "healthy" },
  { label: "failed check", checkMs: 4.75, lifetimeMs: 8.75, outcome: "failed" },
  { label: "failed before checking", checkMs: undefined, lifetimeMs: 8.75, outcome: "failed" },
] as const)(
  "attributes $label worker time without leaking measurements into later gates",
  ({ checkMs, lifetimeMs, outcome }) => {
    const { database, advance } = createTimedDatabase(4.75);
    const diagnostics: SqliteIntegrityDiagnostics = {};
    const failure = new Error("external integrity driver failed");
    const gate = () => sqliteIntegrityCheckSteps(database, "timed database", diagnostics);
    const finish = (operation: SqliteIntegrityOperation<void>) => {
      if (outcome === "failed") {
        expect(caught(() => operation.throw(failure))).toBe(failure);
      } else {
        expect(operation.next().done).toBe(true);
      }
    };
    for (const nextDriver of ["sync", "unmeasured"] as const) {
      runSqliteIntegrityOperationSync(gate());
      expect(diagnostics).toEqual(syncDiagnostics);

      const worker = gate();
      const step = worker.next();
      if (step.done || !step.value.timing) {
        throw new Error("Integrity check did not yield a timing owner");
      }
      step.value.timing.workerLifetimeElapsedMs = lifetimeMs;
      if (checkMs !== undefined) {
        step.value.timing.workerCheckElapsedMs = checkMs;
      }
      advance(lifetimeMs + 4.5);
      finish(worker);
      expect(diagnostics).toEqual({
        integrityGateMode: "full",
        integrityGateMs: Math.floor(lifetimeMs + 4.5),
        integrityGateOutcome: outcome,
        ...(checkMs === undefined ? {} : { integrityWorkerCheckMs: Math.floor(checkMs) }),
        integrityWorkerLifetimeMs: Math.floor(lifetimeMs),
        integrityOutsideWorkerMs: Math.floor(lifetimeMs + 4.5) - Math.floor(lifetimeMs),
      });

      if (nextDriver === "sync") {
        runSqliteIntegrityOperationSync(gate());
        expect(diagnostics).toEqual(syncDiagnostics);
        continue;
      }
      const manual = gate();
      expect(manual.next().done).toBe(false);
      advance(12.5);
      finish(manual);
      expect(diagnostics).toEqual({
        integrityGateMode: "full",
        integrityGateMs: 12,
        integrityGateOutcome: outcome,
      });
      expect(diagnostics).not.toHaveProperty("integrityCheckSyncMs");
      expect(diagnostics).not.toHaveProperty("integrityOutsideCheckMs");
    }
  },
);

it.each([
  [undefined, "integrity check found damage", true],
  [5, "database is locked", false],
  [11, "database disk image is malformed", true],
  [779, "database index is malformed", true],
] as const)("classifies SQLite error %s (%s) as terminal=%s", (errcode, message, terminal) => {
  const error = new Error(message);
  error.name = "SqliteIntegrityError";
  if (errcode !== undefined) {
    error.cause = Object.assign(new Error(message), { errcode });
  }
  expect(isTerminalSqliteIntegrityError(error)).toBe(terminal);
});

it("confirms page corruption despite empty WAL sidecars created by its own reader", () => {
  const databasePath = path.join(tempDirs.make("sqlite-corrupt-wal-"), "database.sqlite");
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE damaged(value TEXT); INSERT INTO damaged VALUES ('preserved');",
  );
  const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size);
  const rootPage = Number(
    database.prepare("SELECT rootpage FROM sqlite_schema WHERE name='damaged'").get()?.rootpage,
  );
  database.close();
  expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
  const bytes = fs.readFileSync(databasePath);
  bytes.writeUInt8(0xff, (rootPage - 1) * pageSize);
  fs.writeFileSync(databasePath, bytes);
  const open = nodeSqlite.openNodeSqliteDatabase;
  let opening = 0;
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = open(...args);
    // Reproduce native empty-WAL creation/retouching independently of SQLite and filesystem versions.
    fs.writeFileSync(`${databasePath}-wal`, "");
    fs.utimesSync(`${databasePath}-wal`, ++opening, opening);
    return db;
  });
  expect(confirmSqliteFileIntegrity(databasePath, "damaged WAL database")).toMatchObject({
    status: "failed",
    terminal: true,
    error: { name: "SqliteIntegrityError" },
    generation: { database: { size: BigInt(fs.statSync(databasePath).size) } },
  });
});

it("leaves SQLite open failures unbound because the failed file identity is unknown", () => {
  const databasePath = path.join(tempDirs.make("sqlite-open-integrity-"), "database.sqlite");
  fs.writeFileSync(databasePath, "not a sqlite database");
  const openError = Object.assign(new Error("file is not a database"), { errcode: 26 });
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementationOnce(() => {
    throw openError;
  });

  expect(confirmSqliteFileIntegrity(databasePath, "test database")).toEqual({
    status: "failed",
    error: openError,
    terminal: false,
  });
});
