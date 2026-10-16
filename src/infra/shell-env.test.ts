import childProcess, { ChildProcess, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type * as KillTreeModule from "../process/kill-tree.js";

let shellEnv: typeof import("./shell-env.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("../process/kill-tree.js");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function readPath(
  env: NodeJS.ProcessEnv,
  exec: ReturnType<typeof vi.fn>,
  timeoutMs?: number,
  platform: NodeJS.Platform = "linux",
) {
  return shellEnv.getShellPathFromLoginShell({
    env,
    platform,
    timeoutMs,
    exec: exec as unknown as Parameters<typeof shellEnv.getShellPathFromLoginShell>[0]["exec"],
  });
}

beforeEach(async () => {
  vi.resetModules();
  shellEnv = await import("./shell-env.js");
});

describe("async login-shell PATH preparation", () => {
  async function holdProbe(
    overrides: Partial<Parameters<typeof shellEnv.prepareShellPathFromLoginShell>[0]> = {},
  ) {
    const options = { env: {}, platform: "linux" as const, ...overrides };
    type ShellProcess = childProcess.ChildProcessByStdio<null, PassThrough, PassThrough>;
    type ShellSpawnOptions = childProcess.SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">;
    let child: ShellProcess;
    const kill = vi.fn(() => true);
    const exec = vi.fn<
      (command: string, args: readonly string[], options: ShellSpawnOptions) => ShellProcess
    >(() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdio: ShellProcess["stdio"] = [null, stdout, stderr, null, null];
      child = Object.assign(new ChildProcess(), { stdin: null, stdout, stderr, stdio, kill });
      return child;
    });
    const sync = vi.fn<typeof childProcess.execFileSync>(() => {
      throw new Error("unexpected synchronous probe");
    });
    vi.doMock("node:child_process", () => ({ ...childProcess, spawn: exec, execFileSync: sync }));
    vi.resetModules();
    shellEnv = await import("./shell-env.js");
    return {
      exec,
      sync,
      kill,
      start: () => shellEnv.prepareShellPathFromLoginShell(options),
      path: () => shellEnv.getShellPathFromLoginShell(options),
      get child() {
        return child;
      },
      finish: (error: Error | null, output = "\0PATH=/shell/bin\0") => {
        if (error) {
          child.emit("error", error);
        }
        child.stdout?.emit("data", Buffer.from(output));
        child.emit("exit", error ? 1 : 0, null);
        child.emit("close", error ? 1 : 0, null);
      },
    };
  }

  function expectReleased(probe: Awaited<ReturnType<typeof holdProbe>>) {
    expect(probe.child.stdout?.destroyed).toBe(true);
    expect(probe.child.stderr?.destroyed).toBe(true);
  }

  async function expectRetry(probe: Awaited<ReturnType<typeof holdProbe>>) {
    const retry = probe.start();
    expect(probe.exec).toHaveBeenCalledTimes(2);
    probe.finish(null);
    await expect(retry).resolves.toBe("/shell/bin");
  }

  it("shares an in-flight probe and makes later synchronous resolution immediate", async () => {
    const probe = await holdProbe({ env: { PATH: "/daemon/bin", SHELL: "relative-shell" } });
    const first = probe.start();
    const second = probe.start();
    expect(second).toBe(first);
    expect(probe.exec).toHaveBeenCalledOnce();
    expect(probe.exec.mock.calls[0]?.[0]).toBe("/bin/sh");
    probe.finish(null, "startup banner\n\0PATH= /shell/bin \0BAD\0");
    await expect(first).resolves.toBe("/shell/bin");
    expect(probe.path()).toBe("/shell/bin");
    await expect(probe.start()).resolves.toBe("/shell/bin");
    expect(probe.sync).not.toHaveBeenCalled();
    expect(probe.exec).toHaveBeenCalledOnce();
  });

  it("preserves a synchronous result published during preparation", async () => {
    const probe = await holdProbe();
    const pending = probe.start();
    probe.sync.mockReturnValue(Buffer.from("\0PATH=/sync/bin\0"));
    expect(probe.path()).toBe("/sync/bin");
    expect(probe.exec.mock.calls[0]).toEqual(probe.sync.mock.calls[0]);
    expect(probe.exec.mock.calls[0]?.[2]).toMatchObject({
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    probe.finish(null);
    await expect(pending).resolves.toBe("/sync/bin");
    expect(probe.path()).toBe("/sync/bin");
  });

  it.each(["spawn error", "timeout", "stdout overflow", "combined output overflow"])(
    "retries %s without caching the failed preparation",
    async (failure) => {
      const probe = await holdProbe();
      const pending = probe.start();
      let error: Error | null = null;
      if (failure === "spawn error") {
        error = new Error("ENOENT");
      } else if (failure === "timeout") {
        Object.defineProperty(probe.child, "killed", { value: true });
      } else {
        if (failure === "combined output overflow") {
          probe.child.stdout?.emit("data", Buffer.alloc(1024 * 1024));
          probe.child.stderr?.emit("data", Buffer.alloc(1024 * 1024 + 1));
        } else {
          probe.child.stdout?.emit("data", Buffer.alloc(2 * 1024 * 1024 + 1));
        }
        expect(probe.kill).toHaveBeenCalledOnce();
      }
      probe.finish(error);
      expectReleased(probe);
      await expect(pending).resolves.toBeNull();
      await expectRetry(probe);
      expect(probe.path()).toBe("/shell/bin");
      expect(probe.sync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["async", "linux", "\0PATH= \0", 1],
    ["async", "linux", "unframed PATH=/shell/bin", 1],
    ["async", "win32", "\0PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0", 0],
    ["sync", "linux", "\0PATH=   \0HOME=/tmp\0", 1],
    ["sync", "win32", "\0PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0", 0],
  ] as const)("caches a null %s PATH on %s for %j", async (mode, platform, output, calls) => {
    if (mode === "async") {
      const probe = await holdProbe({ platform });
      const pending = probe.start();
      if (calls > 0) {
        probe.finish(null, output);
      }
      await expect(pending).resolves.toBeNull();
      expect(probe.path()).toBeNull();
      expect(probe.exec).toHaveBeenCalledTimes(calls);
      expect(probe.sync).not.toHaveBeenCalled();
    } else {
      const exec = vi.fn(() => Buffer.from(output));
      expect(readPath({}, exec, undefined, platform)).toBeNull();
      expect(readPath({}, exec, undefined, platform)).toBeNull();
      expect(exec).toHaveBeenCalledTimes(calls);
    }
  });

  it.each([false, true])(
    "releases the deadline probe for retry after shell exit=%s",
    async (afterExit) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const killProcessTree = vi.fn();
      vi.doMock("../process/kill-tree.js", async (importOriginal) => ({
        ...(await importOriginal<typeof KillTreeModule>()),
        killProcessTree,
      }));
      const probe = await holdProbe({ timeoutMs: 10 });
      const settled = vi.fn();
      const pending = probe.start().then(settled);
      Object.defineProperty(probe.child, "pid", { value: 12345 });
      if (afterExit) {
        await vi.advanceTimersByTimeAsync(4);
        probe.child.stdout?.emit("data", Buffer.from("\0PATH=/expired/bin\0"));
        probe.child.emit("exit", 0, null);
      }
      await vi.advanceTimersByTimeAsync(afterExit ? 6 : 10);
      expect(settled).toHaveBeenCalledWith(null);
      if (afterExit) {
        expect(killProcessTree).not.toHaveBeenCalled();
      } else {
        expect(killProcessTree).toHaveBeenCalledWith(12345, { detached: true, force: true });
      }
      expectReleased(probe);
      await pending;
      await expectRetry(probe);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps timeout and startup environment semantics and separates in-flight keys", async () => {
    const probe = await holdProbe();
    vi.spyOn(fs, "readFileSync").mockReturnValue("/bin/bash\n");
    const env = {
      SHELL: "/bin/bash",
      PATH: "/daemon/bin",
      HOME: "/ignored-home",
      ZDOTDIR: "/ignored-zdotdir",
      BASH_ENV: "/ignored-bash-env",
    };
    const first = shellEnv.prepareShellPathFromLoginShell({
      env,
      timeoutMs: 123,
      platform: "linux",
    });
    expect(probe.exec).toHaveBeenCalledWith(
      "/bin/bash",
      ["-l", "-c", "printf '\\0'; env -0"],
      expect.objectContaining({
        encoding: "buffer",
        timeout: 123,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }),
    );
    expect(probe.exec.mock.calls[0]?.[2]?.env).toMatchObject({
      HOME: os.homedir(),
      ZDOTDIR: undefined,
      BASH_ENV: undefined,
    });
    // The first child's promise is still in flight until the next microtask.
    probe.finish(null);
    const second = shellEnv.prepareShellPathFromLoginShell({
      env,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      platform: "linux",
    });
    expect(second).not.toBe(first);
    expect(probe.exec.mock.calls[1]?.[2]?.timeout).toBe(MAX_TIMER_TIMEOUT_MS);
    probe.finish(null);
    await Promise.all([first, second]);
  });
});

describe("shell env fallback", () => {
  function framedShellEnv(output: string): Buffer {
    return Buffer.from(`\0${output}`);
  }

  function fallback({
    exec,
    enabled = true,
    env = {},
    expectedKeys = ["OPENAI_API_KEY"],
    ...options
  }: Omit<Partial<Parameters<typeof shellEnv.loadShellEnvFallback>[0]>, "exec"> & {
    exec: ReturnType<typeof vi.fn>;
  }) {
    return shellEnv.loadShellEnvFallback({
      ...options,
      enabled,
      env,
      expectedKeys,
      exec: exec as unknown as Parameters<typeof shellEnv.loadShellEnvFallback>[0]["exec"],
    });
  }

  function mockShell(output = "OPENAI_API_KEY=from-shell\0PATH=/usr/local/bin:/usr/bin\0") {
    return vi.fn((_shell: string, _args: readonly string[]) => framedShellEnv(output));
  }

  function unsafeStartupEnv(): NodeJS.ProcessEnv {
    return {
      SHELL: "/bin/bash",
      HOME: "/tmp/evil-home",
      ZDOTDIR: "/tmp/evil-zdotdir",
      BASH_ENV: "/tmp/evil-bash-env",
      PS4: "$(touch /tmp/pwned)",
    };
  }

  function expectSanitizedStartupEnv(receivedEnv: NodeJS.ProcessEnv | undefined) {
    expect(receivedEnv).toMatchObject({
      BASH_ENV: undefined,
      PS4: undefined,
      ZDOTDIR: undefined,
      SHELL: undefined,
      HOME: os.homedir(),
    });
  }

  function registerShells(shells: string[]) {
    const etcShellsContent = `${shells.join("\n")}\n`;
    vi.spyOn(fs, "readFileSync").mockImplementation(
      (filePath, encoding?: BufferEncoding | fs.ReadFileSyncOptions | null) => {
        if (filePath === "/etc/shells" && encoding === "utf8") {
          return etcShellsContent;
        }
        throw new Error(`Unexpected readFileSync(${String(filePath)}) in test`);
      },
    );
  }

  function bashProbe(command: string, expectedKeys = ["PATH"]) {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash" };
    const exec = vi.fn(
      (file: string, args: string[], options: Parameters<typeof execFileSync>[2]) => {
        expect(args).toStrictEqual(["-lic", "printf '\\0'; env -0"]);
        return execFileSync(file, ["-lic", command], options);
      },
    );
    registerShells(["/bin/bash"]);
    return { env, exec, result: fallback({ env, exec, expectedKeys }) };
  }

  it.each([
    ["OPENCLAW_LOAD_SHELL_ENV", "0", "1"],
    ["OPENCLAW_DEFER_SHELL_ENV_FALLBACK", "false", "yes"],
  ] as const)("parses the opt-in %s flag", (key, disabled, enabled) => {
    const parse =
      key === "OPENCLAW_LOAD_SHELL_ENV"
        ? shellEnv.shouldEnableShellEnvFallback
        : shellEnv.shouldDeferShellEnvFallback;
    expect(parse({})).toBe(false);
    expect(parse({ [key]: disabled })).toBe(false);
    expect(parse({ [key]: enabled })).toBe(true);
  });

  it("resolves timeout from env with default fallback", () => {
    for (const [raw, expected] of [
      [undefined, 15000],
      ["42", 42],
      ["nope", 15000],
      ["42abc", 15000],
      [String(Number.MAX_SAFE_INTEGER), MAX_TIMER_TIMEOUT_MS],
    ] as const) {
      expect(
        shellEnv.resolveShellEnvFallbackTimeoutMs(
          raw === undefined ? {} : { OPENCLAW_SHELL_ENV_TIMEOUT_MS: raw },
        ),
      ).toBe(expected);
    }
  });

  it("imports missing expected keys even when another expected key already exists", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_GATEWAY_TOKEN: "set" };
    const exec = mockShell(
      "OPENCLAW_GATEWAY_TOKEN=from-shell\0TWILIO_ACCOUNT_SID=AC123\0TWILIO_AUTH_TOKEN=secret\0TWILIO_FROM_NUMBER=+15550001234\0",
    );

    const res = fallback({
      env,
      expectedKeys: [
        "OPENCLAW_GATEWAY_TOKEN",
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_FROM_NUMBER",
      ],
      exec,
    });

    expect(res).toEqual({
      ok: true,
      applied: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    });
    expect(env).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "set",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "secret",
      TWILIO_FROM_NUMBER: "+15550001234",
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("treats explicitly empty env vars as intentional overrides", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "" };
    const exec = mockShell("OPENAI_API_KEY=from-shell\0");

    const res = fallback({ env, exec });

    expect(res).toEqual({ ok: true, applied: [], skippedReason: "already-has-keys" });
    expect(env.OPENAI_API_KEY).toBe("");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["environment", "PATH"])("retries failed %s probes and caches recovery", (mode) => {
    const logger = { warn: vi.fn() };
    const exec = mockShell().mockImplementationOnce(() => {
      throw new Error(mode === "environment" ? "shell unavailable" : "exec failed");
    });
    const read = (env: NodeJS.ProcessEnv) =>
      mode === "environment" ? fallback({ env, exec, logger }) : readPath(env, exec);
    expect(read({})).toEqual(
      mode === "environment" ? { ok: false, applied: [], error: "shell unavailable" } : null,
    );
    for (let i = 0; i < 2; i += 1) {
      const env: NodeJS.ProcessEnv = {};
      expect(read(env)).toEqual(
        mode === "environment"
          ? { ok: true, applied: ["OPENAI_API_KEY"] }
          : "/usr/local/bin:/usr/bin",
      );
      if (mode === "environment") {
        expect(env.OPENAI_API_KEY).toBe("from-shell");
      }
    }
    expect(exec).toHaveBeenCalledTimes(2);
    if (mode === "environment") {
      expect(logger.warn).toHaveBeenCalledOnce();
    }
  });

  it("tracks last applied keys across success, skip, and failure paths", () => {
    const successEnv: NodeJS.ProcessEnv = {};
    const successExec = mockShell("OPENAI_API_KEY=from-shell\0DISCORD_BOT_TOKEN=\0EXTRA=ignored\0");
    expect(
      fallback({
        env: successEnv,
        expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
        exec: successExec,
      }),
    ).toEqual({
      ok: true,
      applied: ["OPENAI_API_KEY"],
    });
    expect(shellEnv.getShellEnvAppliedKeys()).toEqual(["OPENAI_API_KEY"]);

    expect(fallback({ enabled: false, exec: successExec })).toEqual({
      ok: true,
      applied: [],
      skippedReason: "disabled",
    });
    expect(shellEnv.getShellEnvAppliedKeys()).toStrictEqual([]);

    const failureExec = vi.fn(() => {
      throw new Error("boom");
    });
    expect(
      fallback({
        exec: failureExec,
        logger: { warn: vi.fn() },
      }),
    ).toEqual({
      ok: false,
      applied: [],
      error: "boom",
    });
    expect(shellEnv.getShellEnvAppliedKeys()).toStrictEqual([]);
  });

  it("clears only discarded shell-applied keys", () => {
    fallback({
      expectedKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      exec: mockShell("OPENAI_API_KEY=openai-shell\0ANTHROPIC_API_KEY=anthropic-shell\0"),
    });

    shellEnv.clearShellEnvAppliedKeys(["OPENAI_API_KEY"]);

    expect(shellEnv.getShellEnvAppliedKeys()).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it.each(["relative", "unregistered", "registered"])(
    "selects a trusted shell for %s SHELL",
    (kind) => {
      const trustedShell =
        process.platform === "win32"
          ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
          : "/usr/bin/zsh-trusted";
      const requested =
        kind === "relative"
          ? "zsh"
          : kind === "unregistered"
            ? "/opt/homebrew/bin/evil-shell"
            : trustedShell;
      const exec = mockShell("OPENAI_API_KEY=from-shell\0");
      registerShells(["/bin/sh", "/bin/bash", "/bin/zsh", trustedShell]);
      const res = fallback({ env: { SHELL: requested }, exec });
      expect(res.ok).toBe(true);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(
        kind === "registered" ? trustedShell : "/bin/sh",
        ["-l", "-c", "printf '\\0'; env -0"],
        expect.objectContaining({ windowsHide: true }),
      );
    },
  );

  it("skips shell env fallback on win32 without probing /bin/sh", () => {
    const env: NodeJS.ProcessEnv = {};
    const exec = vi.fn(() => {
      throw new Error("spawnSync /bin/sh ENOENT");
    });
    const logger = { warn: vi.fn() };

    const res = fallback({ env, exec, logger, platform: "win32" });

    expect(res).toEqual({ ok: true, applied: [] });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["environment", "PATH"])("sanitizes %s startup and caps its exec timeout", (mode) => {
    const env = unsafeStartupEnv();
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    let receivedTimeout: number | undefined;
    const exec = vi.fn(
      (_shell: string, _args: string[], options: { env: NodeJS.ProcessEnv; timeout?: number }) => {
        receivedEnv = options.env;
        receivedTimeout = options.timeout;
        return framedShellEnv(
          "OPENAI_API_KEY=from-shell\0PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0",
        );
      },
    );
    const timeoutMs = Number.MAX_SAFE_INTEGER;
    if (mode === "environment") {
      expect(fallback({ env, exec, timeoutMs }).ok).toBe(true);
    } else {
      expect(readPath(env, exec, timeoutMs)).toBe("/usr/local/bin:/usr/bin");
    }
    expect(exec).toHaveBeenCalledTimes(1);
    expectSanitizedStartupEnv(receivedEnv);
    expect(receivedTimeout).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("uses interactive Bash login startup before nounset reads PS1", () => {
    if (process.platform === "win32" || !fs.existsSync("/bin/bash")) {
      return;
    }
    const { exec, result } = bashProbe("set -u; : \"$PS1\"; printf '\\0'; env -0");
    expect(result).toMatchObject({ ok: true });
    expect(exec).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform !== "linux" || !fs.existsSync("/bin/bash"))(
    "runs the login-shell probe in its own session",
    () => {
      const { env, result } = bashProbe(
        'printf \'\\0OPENCLAW_PROBE_PID=%s\\0OPENCLAW_PROBE_SID=%s\\0\' "$$" "$(ps -o sid= -p $$)"; env -0',
        ["OPENCLAW_PROBE_PID", "OPENCLAW_PROBE_SID"],
      );
      expect(result).toEqual({ ok: true, applied: ["OPENCLAW_PROBE_PID", "OPENCLAW_PROBE_SID"] });
      expect(env.OPENCLAW_PROBE_SID?.trim()).toBe(env.OPENCLAW_PROBE_PID);
    },
  );

  it("keeps Bash PATH discovery noninteractive and cached separately from env imports", () => {
    const shell = "/bin/bash";
    const env: NodeJS.ProcessEnv = { SHELL: shell };
    const exec = mockShell();

    registerShells([shell]);
    expect(fallback({ env, exec })).toEqual({ ok: true, applied: ["OPENAI_API_KEY"] });
    expect(readPath(env, exec)).toBe("/usr/local/bin:/usr/bin");

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0]?.[1]).toStrictEqual(["-lic", "printf '\\0'; env -0"]);
    expect(exec.mock.calls[1]?.[1]).toStrictEqual(["-l", "-c", "printf '\\0'; env -0"]);
  });

  it.each([
    ["daemon hit", "fallback", 0],
    ["daemon miss", "fallback", 1],
    ["prefer shell", "prefer", 1],
  ] as const)("resolves an executable with %s", (scenario, strategy, calls) => {
    let executable = "sh";
    let daemonBin = scenario === "daemon miss" ? "/missing" : "/bin";
    let shellBin = "/bin";
    let expectedExecutable = "/bin/sh";
    if (strategy === "prefer") {
      if (process.platform === "win32") {
        return;
      }
      const root = tempDirs.make("openclaw-shell-path-");
      daemonBin = path.join(root, "daemon-bin");
      shellBin = path.join(root, "shell-bin");
      fs.mkdirSync(daemonBin);
      fs.mkdirSync(shellBin);
      executable = "tool";
      fs.writeFileSync(path.join(daemonBin, executable), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      expectedExecutable = path.join(shellBin, executable);
      fs.writeFileSync(expectedExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const exec = mockShell(`PATH=${shellBin}\0`);
    const result = shellEnv.resolveExecutableFromUserShellPath(executable, {
      env: { PATH: daemonBin, SHELL: "/bin/sh" },
      strategy,
      exec: exec as unknown as Parameters<
        typeof shellEnv.resolveExecutableFromUserShellPath
      >[1]["exec"],
    });
    expect(result).toEqual(
      calls === 0
        ? { executable: expectedExecutable }
        : { executable: expectedExecutable, pathEnv: shellBin },
    );
    expect(exec).toHaveBeenCalledTimes(calls);
  });
});
