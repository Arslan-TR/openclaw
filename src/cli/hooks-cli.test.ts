// Hooks CLI tests cover hook command registration and output behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withContendedConfigMutation } from "../../test/helpers/config-mutation-lock.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { formatHookInfo, formatHooksCheck, formatHooksList } from "./hooks-cli.format.js";
import { registerHooksCli } from "./hooks-cli.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";

const runPluginInstallCommandMock = vi.hoisted(() => vi.fn());
const runPluginUpdateCommandMock = vi.hoisted(() => vi.fn());

vi.mock("./plugins-install-command.js", () => ({
  runPluginInstallCommand: runPluginInstallCommandMock,
}));

vi.mock("./plugins-update-command.js", () => ({
  runPluginUpdateCommand: runPluginUpdateCommandMock,
}));

const hook: HookStatusEntry = {
  name: "session-memory",
  description: "Save session context to memory",
  source: "openclaw-bundled",
  pluginId: undefined,
  filePath: "/tmp/hooks/session-memory/HOOK.md",
  baseDir: "/tmp/hooks/session-memory",
  handlerPath: "/tmp/hooks/session-memory/handler.js",
  hookKey: "session-memory",
  emoji: "💾",
  homepage: "https://docs.openclaw.ai/automation/hooks#session-memory",
  events: ["command:new"],
  unknownEvents: [],
  always: false,
  enabledByConfig: true,
  requirementsSatisfied: true,
  loadable: true,
  blockedReason: undefined,
  managedByPlugin: false,
  ...createEmptyInstallChecks(),
};
function withHook(overrides: Partial<HookStatusEntry> = {}): HookStatusReport {
  return {
    workspaceDir: "/tmp/workspace",
    managedHooksDir: "/tmp/hooks",
    hooks: [{ ...hook, ...overrides }],
  };
}
const eventless = withHook({ events: [], loadable: false, blockedReason: "no events defined" });

beforeEach(() => {
  runPluginInstallCommandMock.mockReset();
  runPluginUpdateCommandMock.mockReset();
});

describe("hooks cli formatting", () => {
  it("shows eventless hooks as blocked by their event declaration in verbose list output", () => {
    const output = formatHooksList(eventless, { verbose: true });

    expect(output).toContain("0/1 ready");
    expect(output).toContain("no events defined");
    expect(output).not.toContain("missing requirements");
  });

  it("does not report disabled hook policy as a missing requirement", () => {
    const disabledReport = withHook({
      enabledByConfig: false,
      loadable: false,
      blockedReason: "workspace hook (disabled by default)",
    });
    const output = formatHooksList(disabledReport, { verbose: true });
    expect(output).toContain("disabled");
    expect(output).not.toContain("workspace hook");
  });

  it("shows eventless hooks as blocked by their event declaration in info output", () => {
    const output = formatHookInfo(eventless.hooks[0], "session-memory", {});

    expect(output).toContain("No events defined");
    expect(output).toContain("Blocked reason: no events defined");
    expect(output).not.toContain("Missing requirements");
  });

  it("keeps missing requirement hooks labeled as missing requirements in info output", () => {
    const output = formatHookInfo(
      withHook({
        requirementsSatisfied: false,
        loadable: false,
        blockedReason: "missing requirements",
        requirements: { ...hook.requirements, env: ["DEMO_HOOK_TOKEN"] },
        missing: { ...hook.missing, env: ["DEMO_HOOK_TOKEN"] },
      }).hooks[0],
      "session-memory",
      {},
    );

    expect(output).toContain("Missing requirements");
    expect(output).toContain("DEMO_HOOK_TOKEN");
  });

  it("classifies eventless hooks as not ready in human check output", () => {
    const output = formatHooksCheck(eventless, {});

    expect(output).toContain("Ready: 0");
    expect(output).toContain("Not ready: 1");
    expect(output).toContain("session-memory - no events defined");
  });

  it("classifies eventless hooks as not eligible in JSON check output", () => {
    const output = JSON.parse(formatHooksCheck(eventless, { json: true }));

    expect(output).toMatchObject({
      total: 1,
      eligible: 0,
      notEligible: 1,
      hooks: {
        eligible: [],
        notEligible: [
          {
            name: "session-memory",
            blockedReason: "no events defined",
          },
        ],
      },
    });
  });

  it("labels plugin-managed hooks with plugin id", () => {
    const pluginReport = withHook({
      source: "openclaw-plugin",
      pluginId: "voice-call",
      managedByPlugin: true,
    });

    const output = formatHooksList(pluginReport, {});
    expect(output).toContain("plugin:voice-call");
  });

  it("warns about unknown events in hook info", () => {
    const typoReport = withHook({
      name: "typo-hook",
      events: ["command:nwe", "command:new"],
      unknownEvents: ["command:nwe"],
    });

    const output = formatHookInfo(typoReport.hooks[0], "typo-hook", {});
    expect(output).toContain("Event not emitted by core (likely typo): command:nwe");
  });

  it("forwards install-policy acknowledgement through the deprecated install alias", async () => {
    runPluginInstallCommandMock.mockResolvedValueOnce(undefined);
    const program = new Command().exitOverride();
    registerHooksCli(program);

    await program.parseAsync(
      ["hooks", "install", "npm:demo-hooks", "--force", "--acknowledge-install-policy-warning"],
      { from: "user" },
    );

    expect(runPluginInstallCommandMock).toHaveBeenCalledWith({
      raw: "npm:demo-hooks",
      allowInstallPolicyWarningPrompt: true,
      opts: expect.objectContaining({ force: true, acknowledgeInstallPolicyWarning: true }),
      invalidateRuntimeCache: false,
    });
  });

  it("forwards install-policy acknowledgement through the deprecated update alias", async () => {
    runPluginUpdateCommandMock.mockResolvedValueOnce(undefined);
    const program = new Command().exitOverride();
    registerHooksCli(program);

    await program.parseAsync(
      ["hooks", "update", "demo-hooks", "--acknowledge-install-policy-warning"],
      { from: "user" },
    );

    expect(runPluginUpdateCommandMock).toHaveBeenCalledWith({
      ids: ["demo-hooks"],
      opts: expect.objectContaining({ acknowledgeInstallPolicyWarning: true }),
    });
  });
});

describe("hooks config write ownership", () => {
  it("preserves env references while disable waits for the write lock", async () => {
    await withOpenClawTestState(
      {
        label: "hook-write-env",
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_TEST_HOOK_PREFIX: "before-lock" },
      },
      async (state) => {
        const hookDir = path.join(state.workspaceDir, "hooks", "fixture-hook");
        await fs.mkdir(hookDir, { recursive: true });
        await fs.writeFile(
          path.join(hookDir, "HOOK.md"),
          '---\nname: fixture-hook\ndescription: Fixture hook\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n',
        );
        await fs.writeFile(
          path.join(hookDir, "handler.js"),
          "export default async function () {}\n",
        );
        await state.writeConfig({
          messages: { responsePrefix: "${OPENCLAW_TEST_HOOK_PREFIX}" },
          agents: {
            ownership: "explicit",
            entries: { fixture: { workspace: state.workspaceDir } },
            defaults: { systemAgent: { agentId: "fixture" } },
          },
          hooks: {
            internal: {
              enabled: true,
              entries: { "fixture-hook": { enabled: true } },
            },
          },
        });
        const raw = await fs.readFile(state.configPath, "utf8");
        const program = new Command().enablePositionalOptions();
        registerHooksCli(program);
        await withContendedConfigMutation(
          state.configPath,
          () =>
            program.parseAsync(["hooks", "disable", "fixture-hook", "--agent", "fixture"], {
              from: "user",
            }),
          async () => {
            expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
            process.env.OPENCLAW_TEST_HOOK_PREFIX = "after-lock";
          },
        );
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
          messages: { responsePrefix: "${OPENCLAW_TEST_HOOK_PREFIX}" },
          hooks: { internal: { entries: { "fixture-hook": { enabled: false } } } },
        });
        const fresh = await readConfigFileSnapshot();
        expect(fresh.valid).toBe(true);
        expect(fresh.sourceConfig.messages?.responsePrefix).toBe("after-lock");
      },
    );
  });
});
