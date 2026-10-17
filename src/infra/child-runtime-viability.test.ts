import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  classifyChildRuntimeFailure,
  formatChildRuntimeSpawnWarning,
  formatMissingChildRuntimeWarning,
  readChildRuntimeViability,
} from "./child-runtime-viability.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const log = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));

const removedCellarPath = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node";

describe("child runtime viability", () => {
  it.each([
    { path: "/missing-user-command", code: "ENOENT" },
    { path: process.execPath, code: "ENOENT" },
    { path: process.execPath, code: "EACCES" },
  ])("does not mislabel a command, cwd, or permission failure: $path $code", (fields) => {
    expect(
      formatChildRuntimeSpawnWarning(Object.assign(new Error("spawn failed"), fields)),
    ).toBeUndefined();
  });
  it.each([
    { execPath: removedCellarPath, code: "ENOENT", available: false },
    { execPath: process.execPath, code: undefined, available: true },
    { execPath: "/fixture/restricted-node", code: "EACCES", available: true },
  ])("classifies executable access $code", ({ execPath, code, available }) => {
    const viability = readChildRuntimeViability({
      execPath,
      access: () => {
        if (code) {
          throw Object.assign(new Error(code), { code });
        }
      },
    });
    expect(viability).toEqual({ execPath, available });
    expect(formatMissingChildRuntimeWarning(viability)).toBe(
      available
        ? undefined
        : `The Node.js runtime this Gateway started with (${removedCellarPath}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`,
    );
  });
});

it("records a permanent loader failure once and does not confuse a post-handshake crash", () => {
  const execPath = "/fixture/permanently-unavailable-node";
  log.error.mockClear();
  expect(
    classifyChildRuntimeFailure({
      execPath,
      started: true,
      stderr: "dyld[123]: Library not loaded: /fixture/lib.dylib",
    }),
  ).toBeUndefined();
  const failure = classifyChildRuntimeFailure({
    execPath,
    stderr: "dyld[123]: Library not loaded: /fixture/lib.dylib",
  });
  expect(failure).toMatchObject({ code: "NODE_RUNTIME_UNAVAILABLE" });
  expect(classifyChildRuntimeFailure({ execPath, signal: "SIGABRT" })).toBe(failure);
  expect(readChildRuntimeViability({ execPath, access: () => {} }).available).toBe(false);
  expect(log.error).toHaveBeenCalledExactlyOnceWith(failure?.message);
});

it("does not latch an unchanged runtime when both worker and diagnostic probe abort", () => {
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 123,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: "SIGABRT",
  });
  expect(classifyChildRuntimeFailure({ signal: "SIGABRT" })).toBeUndefined();
  expect(readChildRuntimeViability().available).toBe(true);
});

it("classifies an executable changed since startup when its bare runtime also aborts", () => {
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 123,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: "SIGABRT",
  });
  expect(
    classifyChildRuntimeFailure({
      execPath: "/fixture/replaced-node",
      signal: "SIGABRT",
    }),
  ).toMatchObject({ code: "NODE_RUNTIME_UNAVAILABLE" });
});
