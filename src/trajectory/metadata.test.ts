import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import {
  redactPathForSupport,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { SkillSnapshot } from "../skills/types.js";

type ResolvedSkillEntry = NonNullable<SkillSnapshot["resolvedSkills"]>[number];

function resolvedSkill(name: string): ResolvedSkillEntry {
  const baseDir = `/tmp/workspace/skills/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return {
    name,
    description: `Check ${name}`,
    filePath,
    baseDir,
    source: "workspace",
    sourceInfo: {
      path: filePath,
      source: "workspace",
      scope: "project",
      origin: "top-level",
      baseDir,
    },
    disableModelInvocation: false,
  };
}

const partialSkill = {
  name: undefined,
  description: undefined,
  filePath: undefined,
  baseDir: undefined,
  source: "workspace",
  sourceInfo: undefined,
  disableModelInvocation: false,
} as unknown as ResolvedSkillEntry;

function metadata(params: Partial<Parameters<typeof buildTrajectoryRunMetadata>[0]> = {}) {
  return buildTrajectoryRunMetadata({
    workspaceDir: "/tmp/workspace",
    sessionFile: "/tmp/workspace/session.jsonl",
    timeoutMs: 30_000,
    ...params,
  });
}

function skillsSnapshot(resolvedSkills: ResolvedSkillEntry[], names: string[] = []): SkillSnapshot {
  return {
    prompt: "skill prompt",
    version: 1,
    skills: names.map((name) => ({ name })),
    resolvedSkills,
  };
}

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn(() => ({ plugins: [] })));

vi.mock("../infra/git-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/git-commit.js")>()),
  resolveCommitHash: () => "abcdef0",
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: () => ({
    platform: "darwin",
    arch: "arm64",
    release: "test-release",
    label: "test-os",
  }),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: loadPluginManifestRegistry,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => {
    const registry = loadPluginManifestRegistry();
    return {
      plugins: registry.plugins,
      manifestRegistry: registry,
    };
  },
}));

import { buildTrajectoryArtifacts, buildTrajectoryRunMetadata } from "./metadata.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  loadPluginManifestRegistry.mockClear();
});

describe("trajectory metadata", () => {
  it("uses prepared plugin metadata without rescanning manifests", () => {
    const result = metadata({
      sessionFile: undefined,
      pluginMetadataSnapshot: {
        plugins: [
          {
            id: "prepared-plugin",
            name: "Prepared Plugin",
            origin: "bundled",
            channels: [],
            providers: [],
            cliBackends: [],
            hooks: [],
            skills: [],
          },
        ],
      } as never,
    });

    expect(result.plugins).toMatchObject({
      source: "manifest-registry",
      entries: [{ id: "prepared-plugin" }],
    });
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("redacts harness argv and local paths with the support redaction rules", () => {
    const originalArgv = process.argv;
    process.argv = [
      "node",
      "/Users/tester/project/openclaw.js",
      "--api-key",
      "super-secret",
      "--config=/Users/tester/.openclaw/openclaw.json",
    ];
    try {
      const result = metadata({
        env: {
          HOME: "/Users/tester",
          OPENCLAW_STATE_DIR: "/Users/tester/.openclaw",
        },
        workspaceDir: "/Users/tester/project",
        sessionFile: "/Users/tester/project/session.jsonl",
      });

      expect(result.harness).toMatchObject({
        invocation: [
          "node",
          "~/project/openclaw.js",
          "--api-key",
          "<redacted>",
          "--config=$OPENCLAW_STATE_DIR/openclaw.json",
        ],
        entrypoint: "~/project/openclaw.js",
        workspaceDir: "~/project",
        sessionFile: "~/project/session.jsonl",
      });
    } finally {
      process.argv = originalArgv;
    }
  });

  it("captures redacted config plus active plugin and skill inventory", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "demo-plugin",
        name: "Demo Plugin",
        version: "1.2.3",
        source: "bundled",
        origin: "bundled",
        imported: true,
        toolNames: ["demo_tool"],
        channelIds: ["demo-channel"],
        providerIds: ["demo-provider"],
        agentHarnessIds: ["openclaw"],
      }),
    );
    setActivePluginRegistry(registry, "trajectory-metadata-test");

    const result = metadata({
      config: {
        providers: {
          openai: {
            apiKey: "super-secret",
          },
        },
      } as never,
      skillsSnapshot: skillsSnapshot([resolvedSkill("weather")], ["weather"]),
      reasoningLevel: "high",
    });

    expect(result.config).toMatchObject({
      redacted: { providers: { openai: { apiKey: REDACTED_SENTINEL } } },
    });
    expect(result.plugins).toMatchObject({
      source: "active-registry",
      entries: [{ id: "demo-plugin" }],
    });
    expect(result.skills).toMatchObject({
      entries: [{ id: "weather", filePath: "/tmp/workspace/skills/weather/SKILL.md" }],
    });
  });

  it("tolerates skill snapshot entries with missing name/paths (symlink-escape rejects)", () => {
    const result = metadata({
      skillsSnapshot: skillsSnapshot([resolvedSkill("alpha"), partialSkill]),
    });
    expect(result.skills).toMatchObject({ entries: [{ name: "alpha" }] });
  });

  it("falls back to skills list when every resolvedSkills entry is partial", () => {
    const result = metadata({ skillsSnapshot: skillsSnapshot([partialSkill], ["fallback-skill"]) });
    expect(result.skills).toMatchObject({ entries: [{ name: "fallback-skill" }] });
  });

  it("redactPathForSupport returns empty string for null/undefined input", () => {
    const ctx: SupportRedactionContext = { env: {}, stateDir: "/tmp/.openclaw" };
    expect(redactPathForSupport(undefined, ctx)).toBe("");
    expect(redactPathForSupport(null, ctx)).toBe("");
  });

  it("captures final artifact summaries for export sidecars", () => {
    const artifacts = buildTrajectoryArtifacts({
      status: "success",
      aborted: false,
      externalAbort: false,
      timedOut: false,
      idleTimedOut: false,
      timedOutDuringCompaction: false,
      timedOutDuringToolExecution: false,
      timedOutByRunBudget: false,
      compactionCount: 1,
      assistantTexts: ["done"],
      finalPromptText: "run tests",
      itemLifecycle: {
        startedCount: 2,
        completedCount: 2,
        activeCount: 0,
      },
      toolMetas: [{ toolName: "bash", meta: "npm test" }],
      didSendViaMessagingTool: false,
      successfulCronAdds: 0,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
    });

    expect(artifacts).toMatchObject({
      finalStatus: "success",
      assistantTexts: ["done"],
      itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
    });
  });
});
