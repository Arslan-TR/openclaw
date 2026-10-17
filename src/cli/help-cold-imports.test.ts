import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";

const loaded = vi.hoisted(() => {
  const modules = new Set<string>();
  return {
    modules,
    stub(name: string, key: string) {
      return () => {
        modules.add(name);
        return { [key]: vi.fn(async () => {}) };
      };
    },
    track<T>(name: string, exports: T): T {
      modules.add(name);
      return exports;
    },
  };
});
vi.mock("./gateway-cli/run.js", () =>
  loaded.track("gateway-run", {
    resolveGatewayRunOptions: vi.fn((opts) => opts),
    runGatewayCommand: vi.fn(async () => {}),
  }),
);
vi.mock("./gateway-rpc.runtime.js", () =>
  loaded.track("gateway-call", {
    callGatewayFromCliRuntime: vi.fn(async () => ({})),
  }),
);
vi.mock("../gateway/call.js", () =>
  loaded.track("gateway-transport", {
    formatGatewayTransportErrorJson: vi.fn(() => null),
  }),
);
vi.mock("./progress.js", () =>
  loaded.track("cli-progress", {
    withProgress: vi.fn(async (_opts, run) => await run({})),
  }),
);
vi.mock("../runtime.js", () =>
  loaded.track("default", {
    defaultRuntime: {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
      writeJson: vi.fn(),
      writeStdout: vi.fn(),
    },
  }),
);
vi.mock("../commands/doctor.js", loaded.stub("doctor", "doctorCommand"));
vi.mock("../commands/dashboard.js", loaded.stub("dashboard", "dashboardCommand"));
vi.mock("../commands/reset.js", loaded.stub("reset", "resetCommand"));
vi.mock("../commands/uninstall.js", loaded.stub("uninstall", "uninstallCommand"));
vi.mock("../commands/status.js", loaded.stub("status", "statusCommand"));
vi.mock("../commands/health.js", () =>
  loaded.track("health", {
    formatHealthChannelLines: vi.fn(() => []),
    healthCommand: vi.fn(async () => {}),
  }),
);
vi.mock("../commands/sessions.js", loaded.stub("sessions", "sessionsCommand"));
vi.mock(
  "../commands/sessions-cleanup.js",
  loaded.stub("sessions-cleanup", "sessionsCleanupCommand"),
);
vi.mock(
  "../commands/export-trajectory.js",
  loaded.stub("export-trajectory", "exportTrajectoryCommand"),
);
vi.mock(
  "../commands/configure.commands.js",
  loaded.stub("configure", "configureCommandFromSectionsArg"),
);
vi.mock("../commands/configure.wizard.js", loaded.stub("configure-wizard", "runConfigureWizard"));
vi.mock("../commands/onboard.js", loaded.stub("onboard", "setupWizardCommand"));
vi.mock("../commands/setup.js", loaded.stub("setup", "setupCommand"));
vi.mock("../commands/agent-via-gateway.js", loaded.stub("agent-via-gateway", "agentCliCommand"));
vi.mock("../commands/agent-exec.js", loaded.stub("agent-exec", "agentExecCommand"));
vi.mock("../commands/agents.commands.add.js", loaded.stub("agents-add", "agentsAddCommand"));
vi.mock("../commands/agents.commands.bind.js", async (importOriginal) => {
  loaded.track("agents-bind", undefined);
  return {
    ...(await importOriginal<typeof import("../commands/agents.commands.bind.js")>()),
    agentsBindingsCommand: vi.fn(async () => {}),
    agentsUpdateBindingsCommand: vi.fn(async () => {}),
  };
});
vi.mock(
  "../commands/agents.commands.delete.js",
  loaded.stub("agents-delete", "agentsDeleteCommand"),
);
vi.mock(
  "../commands/agents.commands.identity.js",
  loaded.stub("agents-identity", "agentsSetIdentityCommand"),
);
vi.mock("../commands/agents.commands.list.js", loaded.stub("agents-list", "agentsListCommand"));
vi.mock("@clack/prompts", () =>
  loaded.track("clack-prompts", {
    confirm: vi.fn(async () => true),
  }),
);
vi.mock("../secrets/apply.js", () =>
  loaded.track("secrets-apply", {
    runSecretsApply: vi.fn(async () => ({})),
  }),
);
vi.mock("../secrets/audit.js", () =>
  loaded.track("secrets-audit", {
    resolveSecretsAuditExitCode: vi.fn(() => 0),
    runSecretsAudit: vi.fn(async () => ({})),
  }),
);
vi.mock("../secrets/configure.js", () =>
  loaded.track("secrets-configure", {
    runSecretsConfigureInteractive: vi.fn(async () => ({})),
  }),
);
vi.mock("../secrets/plan.js", () =>
  loaded.track("secrets-plan", {
    isSecretsApplyPlan: vi.fn(() => true),
  }),
);

async function expectHelpExit(register: (program: Command) => void, ...commands: string[]) {
  const program = new Command().name("openclaw").exitOverride();
  register(program);
  for (const command of commands) {
    await expect(
      program.parseAsync([...command.split(" "), "--help"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 0 });
  }
}

describe("subcommand help cold imports", () => {
  beforeEach(() => {
    vi.resetModules();
    loaded.modules.clear();
  });

  it("keeps gateway help out of gateway action/runtime modules", async () => {
    const { registerGatewayCli } = await import("./gateway-cli/register.js");
    await expectHelpExit(registerGatewayCli, "gateway");

    expect(loaded.modules).not.toContain("gateway-run");
    expect(loaded.modules).not.toContain("gateway-call");
    expect(loaded.modules).not.toContain("gateway-transport");
    expect(loaded.modules).not.toContain("cli-progress");
  });

  it("keeps maintenance help out of command action modules", async () => {
    const { registerMaintenanceCommands } = await import("./program/register.maintenance.js");
    await expectHelpExit(registerMaintenanceCommands, "doctor");

    expect(loaded.modules).not.toContain("doctor");
    expect(loaded.modules).not.toContain("dashboard");
    expect(loaded.modules).not.toContain("reset");
    expect(loaded.modules).not.toContain("uninstall");
  });

  it("keeps status and health help out of command action modules", async () => {
    const { registerStatusHealthSessionsCommands } =
      await import("./program/register.status-health-sessions.js");
    await expectHelpExit(registerStatusHealthSessionsCommands, "status", "health");

    expect(loaded.modules).not.toContain("status");
    expect(loaded.modules).not.toContain("health");
    expect(loaded.modules).not.toContain("sessions");
    expect(loaded.modules).not.toContain("sessions-cleanup");
    expect(loaded.modules).not.toContain("export-trajectory");
  });

  it("keeps configure help out of configure action/wizard modules", async () => {
    const { registerConfigureCommand } = await import("./program/register.configure.js");
    await expectHelpExit(registerConfigureCommand, "configure");

    expect(loaded.modules).not.toContain("configure");
    expect(loaded.modules).not.toContain("configure-wizard");
    expect(loaded.modules).not.toContain("default");
  });

  it("keeps setup help out of setup and onboard action modules", async () => {
    const { registerSetupCommand } = await import("./program/register.setup.js");
    await expectHelpExit(registerSetupCommand, "setup");

    expect(loaded.modules).not.toContain("setup");
    expect(loaded.modules).not.toContain("onboard");
    expect(loaded.modules).not.toContain("default");
  });

  it("keeps onboard help out of onboard action modules", async () => {
    const { registerOnboardCommand } = await import("./program/register.onboard.js");
    await expectHelpExit(registerOnboardCommand, "onboard");

    expect(loaded.modules).not.toContain("onboard");
    expect(loaded.modules).not.toContain("default");
  });

  it.each(["agent", "agent exec", "agents"])(
    "keeps %s help out of agent action modules",
    async (command) => {
      const { registerAgentsCommands } = await import("./program/register.agent.js");
      const { registerAgentTurnCommand } = await import("./program/register.agent-turn.js");
      await expectHelpExit((program) => {
        registerAgentTurnCommand(program, { agentChannelOptions: "last|telegram|discord" });
        registerAgentsCommands(program);
      }, command);

      expect(loaded.modules).not.toContain("agent-via-gateway");
      expect(loaded.modules).not.toContain("agent-exec");
      expect(loaded.modules).not.toContain("agents-add");
      expect(loaded.modules).not.toContain("agents-bind");
      expect(loaded.modules).not.toContain("agents-delete");
      expect(loaded.modules).not.toContain("agents-identity");
      expect(loaded.modules).not.toContain("agents-list");
      expect(loaded.modules).not.toContain("default");
    },
  );

  it("keeps secrets help out of secrets action modules", async () => {
    const { registerSecretsCli } = await import("./secrets-cli.js");
    await expectHelpExit(registerSecretsCli, "secrets");

    expect(loaded.modules).not.toContain("clack-prompts");
    expect(loaded.modules).not.toContain("secrets-apply");
    expect(loaded.modules).not.toContain("secrets-audit");
    expect(loaded.modules).not.toContain("secrets-configure");
    expect(loaded.modules).not.toContain("secrets-plan");
  });
});
