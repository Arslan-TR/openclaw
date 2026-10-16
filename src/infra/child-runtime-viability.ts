import { spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasErrnoCode } from "./errno.js";

export type ChildRuntimeViability = {
  execPath: string;
  available: boolean;
};
const runtime = resolveGlobalSingleton(
  Symbol.for("openclaw.childRuntimeViability"),
  (): { initialPath: string; initialIdentity?: string; execPath?: string; failure?: Error } => ({
    initialPath: process.execPath,
    initialIdentity: executableIdentity(process.execPath),
  }),
);
const loaderFailure =
  /(?:dyld[^\n]*:\s*Library not loaded:|error while loading shared libraries:|dyld[^\n]*:\s*Symbol not found:)/i;

const ambiguousLoaderFailure =
  /(?:symbol lookup error:|Error loading shared library|version [`'"][^`'"\r\n]+[`'"] not found)/i;

function executableIdentity(execPath: string): string | undefined {
  try {
    const { dev, ino, size, mtimeMs, mode } = statSync(execPath);
    return `${dev}:${ino}:${size}:${mtimeMs}:${mode}`;
  } catch {
    return undefined;
  }
}

function accessExecutable(execPath: string): void {
  accessSync(execPath, constants.X_OK);
}

export function readChildRuntimeViability(params?: {
  execPath?: string;
  access?: (execPath: string) => void;
}): ChildRuntimeViability {
  const execPath = params?.execPath ?? process.execPath;
  if (runtime.execPath === execPath && runtime.failure) {
    return { execPath, available: false };
  }
  let available = true;
  try {
    (params?.access ?? accessExecutable)(execPath);
  } catch (error) {
    available = !(hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR"));
  }
  return { execPath, available };
}

export function formatMissingChildRuntimeWarning(
  viability: ChildRuntimeViability,
): string | undefined {
  return viability.available
    ? undefined
    : `The Node.js runtime this Gateway started with (${sanitizeTerminalText(viability.execPath)}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`;
}

/** A permanent launch failure belongs to the runtime, not to any one worker pool. */
export function assertChildRuntimeAvailable(): void {
  if (runtime.execPath === process.execPath && runtime.failure) {
    throw runtime.failure;
  }
}

export function classifyChildRuntimeFailure(params: {
  execPath?: string;
  error?: unknown;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  started?: boolean;
}): Error | undefined {
  if (params.started) {
    return undefined;
  }
  const execPath = params.execPath ?? process.execPath;
  if (runtime.execPath === execPath && runtime.failure) {
    return runtime.failure;
  }
  let unavailable = loaderFailure.test(params.stderr ?? "");
  if (params.error && !readChildRuntimeViability({ execPath }).available) {
    unavailable = true;
  }
  const execError =
    params.error instanceof Error &&
    "path" in params.error &&
    params.error.path === execPath &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ENOEXEC"].some((code) =>
      hasErrnoCode(params.error, code),
    );
  if (
    !unavailable &&
    (params.signal === "SIGABRT" || execError || ambiguousLoaderFailure.test(params.stderr ?? ""))
  ) {
    // A worker bug or memory pressure can abort too. Require a loader diagnostic
    // or an observed executable change before treating a bare abort as permanent.
    // These loader messages can also come from worker-only native modules.
    const probe = spawnSync(execPath, ["--version"], {
      encoding: "utf8",
      cwd: path.parse(execPath).root,
      env: { ...process.env, NODE_OPTIONS: undefined },
      timeout: 1_000,
      maxBuffer: 8_192,
    });
    const changed =
      execPath !== runtime.initialPath || executableIdentity(execPath) !== runtime.initialIdentity;
    unavailable =
      loaderFailure.test(probe.stderr ?? "") ||
      ambiguousLoaderFailure.test(probe.stderr ?? "") ||
      hasErrnoCode(probe.error, "ENOENT") ||
      hasErrnoCode(probe.error, "ENOTDIR") ||
      (changed &&
        (probe.signal === "SIGABRT" ||
          hasErrnoCode(probe.error, "ENOEXEC") ||
          hasErrnoCode(probe.error, "EACCES") ||
          hasErrnoCode(probe.error, "EPERM")));
  }
  if (!unavailable) {
    return undefined;
  }
  runtime.execPath = execPath;
  runtime.failure = Object.assign(
    new Error(formatMissingChildRuntimeWarning({ execPath, available: false }), {
      cause: params.error,
    }),
    { code: "NODE_RUNTIME_UNAVAILABLE" },
  );
  createSubsystemLogger("gateway/runtime").error(runtime.failure.message);
  return runtime.failure;
}

/** Capture startup evidence; the owner reads the diagnosis after native completion. */
export function observeChildRuntime(
  child: ChildProcess,
  execPath = process.execPath,
): () => Error | undefined {
  let started = false;
  let error: unknown;
  let stderr = "";
  child.once("message", () => {
    started = true;
    stderr = "";
  });
  child.on("error", (cause) => {
    error ??= cause;
  });
  const captureStderr = (chunk: Buffer | string) => {
    if (!started) {
      stderr = (stderr + chunk.toString()).slice(-8_192);
    }
  };
  child.stderr?.on("data", captureStderr);
  return () =>
    child.exitCode === 0 && !error
      ? undefined
      : classifyChildRuntimeFailure({ execPath, error, stderr, signal: child.signalCode, started });
}

/** Missing commands and missing working directories are not runtime failures. */
export function formatChildRuntimeSpawnWarning(error: unknown): string | undefined {
  if (error instanceof Error && "path" in error && error.path === process.execPath) {
    return classifyChildRuntimeFailure({ error })?.message;
  }
  return undefined;
}
