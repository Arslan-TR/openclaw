// Help cold import tests cover root help output without loading heavy command modules.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";

const loaded = vi.hoisted(() => {
  const modules = new Set<string>();
  return {
    modules,
    track<T>(name: string, exports: T): T {
      modules.add(name);
      return exports;
    },
  };
});

vi.mock("./gateway-cli/run.js", () =>
  loaded.track("gateway-run-runtime", {
    resolveGatewayRunOptions: vi.fn((opts) => opts),
    runGatewayCommand: vi.fn(async () => {}),
  }),
);

vi.mock("./gateway-rpc.runtime.js", () =>
  loaded.track("gateway-call-runtime", {
    callGatewayFromCliRuntime: vi.fn(async () => ({})),
  }),
);

vi.mock("../gateway/call.js", () =>
  loaded.track("gateway-transport-runtime", {
    formatGatewayTransportErrorJson: vi.fn(() => null),
  }),
);

vi.mock("./progress.js", () =>
  loaded.track("cli-progress-runtime", {
    withProgress: vi.fn(async (_opts, run) => await run({})),
  }),
);

vi.mock("../runtime.js", () =>
  loaded.track("default-runtime", {
    defaultRuntime: {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
      writeJson: vi.fn(),
      writeStdout: vi.fn(),
    },
  }),
);

vi.mock("../commands/doctor.js", () =>
  loaded.track("doctor-command", { doctorCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/dashboard.js", () =>
  loaded.track("dashboard-command", { dashboardCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/reset.js", () =>
  loaded.track("reset-command", { resetCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/uninstall.js", () =>
  loaded.track("uninstall-command", { uninstallCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/status.js", () =>
  loaded.track("status-command", { statusCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/health.js", () =>
  loaded.track("health-command", {
    formatHealthChannelLines: vi.fn(() => []),
    healthCommand: vi.fn(async () => {}),
  }),
);

vi.mock("../commands/sessions.js", () =>
  loaded.track("sessions-command", { sessionsCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/sessions-cleanup.js", () =>
  loaded.track("sessions-cleanup-command", { sessionsCleanupCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/export-trajectory.js", () =>
  loaded.track("export-trajectory-command", { exportTrajectoryCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/configure.commands.js", () =>
  loaded.track("configure-command", { configureCommandFromSectionsArg: vi.fn(async () => {}) }),
);

vi.mock("../commands/configure.wizard.js", () =>
  loaded.track("configure-wizard", { runConfigureWizard: vi.fn(async () => {}) }),
);

vi.mock("../commands/onboard.js", () =>
  loaded.track("onboard-command", { setupWizardCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/setup.js", () =>
  loaded.track("setup-command", { setupCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/agent-via-gateway.js", () =>
  loaded.track("agent-via-gateway-command", { agentCliCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/agent-exec.js", () =>
  loaded.track("agent-exec-command", { agentExecCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/agents.commands.add.js", () =>
  loaded.track("agents-add-command", { agentsAddCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/agents.commands.bind.js", async (importOriginal) => {
  loaded.track("agents-bind-command", undefined);
  return {
    ...(await importOriginal<typeof import("../commands/agents.commands.bind.js")>()),
    agentsBindingsCommand: vi.fn(async () => {}),
    agentsUpdateBindingsCommand: vi.fn(async () => {}),
  };
});

vi.mock("../commands/agents.commands.delete.js", () =>
  loaded.track("agents-delete-command", { agentsDeleteCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/agents.commands.identity.js", () =>
  loaded.track("agents-identity-command", { agentsSetIdentityCommand: vi.fn(async () => {}) }),
);

vi.mock("../commands/agents.commands.list.js", () =>
  loaded.track("agents-list-command", { agentsListCommand: vi.fn(async () => {}) }),
);

vi.mock("@clack/prompts", () =>
  loaded.track("clack-prompts", {
    confirm: vi.fn(async () => true),
  }),
);

vi.mock("../secrets/apply.js", () =>
  loaded.track("secrets-apply-runtime", {
    runSecretsApply: vi.fn(async () => ({})),
  }),
);

vi.mock("../secrets/audit.js", () =>
  loaded.track("secrets-audit-runtime", {
    resolveSecretsAuditExitCode: vi.fn(() => 0),
    runSecretsAudit: vi.fn(async () => ({})),
  }),
);

vi.mock("../secrets/configure.js", () =>
  loaded.track("secrets-configure-runtime", {
    runSecretsConfigureInteractive: vi.fn(async () => ({})),
  }),
);

vi.mock("../secrets/plan.js", () =>
  loaded.track("secrets-plan-runtime", {
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

    expect(loaded.modules).not.toContain("gateway-run-runtime");
    expect(loaded.modules).not.toContain("gateway-call-runtime");
    expect(loaded.modules).not.toContain("gateway-transport-runtime");
    expect(loaded.modules).not.toContain("cli-progress-runtime");
  });

  it("keeps maintenance help out of command action modules", async () => {
    const { registerMaintenanceCommands } = await import("./program/register.maintenance.js");
    await expectHelpExit(registerMaintenanceCommands, "doctor");

    expect(loaded.modules).not.toContain("doctor-command");
    expect(loaded.modules).not.toContain("dashboard-command");
    expect(loaded.modules).not.toContain("reset-command");
    expect(loaded.modules).not.toContain("uninstall-command");
  });

  it("keeps status and health help out of command action modules", async () => {
    const { registerStatusHealthSessionsCommands } =
      await import("./program/register.status-health-sessions.js");
    await expectHelpExit(registerStatusHealthSessionsCommands, "status", "health");

    expect(loaded.modules).not.toContain("status-command");
    expect(loaded.modules).not.toContain("health-command");
    expect(loaded.modules).not.toContain("sessions-command");
    expect(loaded.modules).not.toContain("sessions-cleanup-command");
    expect(loaded.modules).not.toContain("export-trajectory-command");
  });

  it("keeps configure help out of configure action/wizard modules", async () => {
    const { registerConfigureCommand } = await import("./program/register.configure.js");
    await expectHelpExit(registerConfigureCommand, "configure");

    expect(loaded.modules).not.toContain("configure-command");
    expect(loaded.modules).not.toContain("configure-wizard");
    expect(loaded.modules).not.toContain("default-runtime");
  });

  it("keeps setup help out of setup and onboard action modules", async () => {
    const { registerSetupCommand } = await import("./program/register.setup.js");
    await expectHelpExit(registerSetupCommand, "setup");

    expect(loaded.modules).not.toContain("setup-command");
    expect(loaded.modules).not.toContain("onboard-command");
    expect(loaded.modules).not.toContain("default-runtime");
  });

  it("keeps onboard help out of onboard action modules", async () => {
    const { registerOnboardCommand } = await import("./program/register.onboard.js");
    await expectHelpExit(registerOnboardCommand, "onboard");

    expect(loaded.modules).not.toContain("onboard-command");
    expect(loaded.modules).not.toContain("default-runtime");
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

      expect(loaded.modules).not.toContain("agent-via-gateway-command");
      expect(loaded.modules).not.toContain("agent-exec-command");
      expect(loaded.modules).not.toContain("agents-add-command");
      expect(loaded.modules).not.toContain("agents-bind-command");
      expect(loaded.modules).not.toContain("agents-delete-command");
      expect(loaded.modules).not.toContain("agents-identity-command");
      expect(loaded.modules).not.toContain("agents-list-command");
      expect(loaded.modules).not.toContain("default-runtime");
    },
  );

  it("keeps secrets help out of secrets action modules", async () => {
    const { registerSecretsCli } = await import("./secrets-cli.js");
    await expectHelpExit(registerSecretsCli, "secrets");

    expect(loaded.modules).not.toContain("clack-prompts");
    expect(loaded.modules).not.toContain("secrets-apply-runtime");
    expect(loaded.modules).not.toContain("secrets-audit-runtime");
    expect(loaded.modules).not.toContain("secrets-configure-runtime");
    expect(loaded.modules).not.toContain("secrets-plan-runtime");
  });
});
