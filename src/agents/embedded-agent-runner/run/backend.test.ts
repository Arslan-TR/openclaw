import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  getCoreTtsAttemptResultMediaUrls,
  markCoreTtsAttemptResult,
} from "../../tools/tts-tool-result-provenance.js";
import { registerAgentWorkspaceAccess, type AgentWorkspaceAccess } from "../../workspace-access.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

const harnessMocks = vi.hoisted(() => ({
  runAttempt: vi.fn(),
}));
const accepted = { runId: "child", childSessionKey: "agent:main:subagent:child" };

function runBackend(
  params: Record<string, unknown> = {},
  runtime?: Parameters<typeof runEmbeddedAttemptWithBackend>[1],
) {
  return runEmbeddedAttemptWithBackend(
    {
      admittedRunContext: { operationalRunInstance: createOperationalRunInstanceRef("test") },
      ...params,
    } as never,
    runtime,
  );
}

beforeEach(() => {
  harnessMocks.runAttempt.mockReset();
});

vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessAttempt: harnessMocks.runAttempt,
  runAgentHarnessSettledTurnFinalization: vi.fn(),
}));

describe("embedded attempt backend", () => {
  it("carries child receipts across model candidates only for the same admitted instance", async () => {
    const instance = createOperationalRunInstanceRef("parent");
    const receipt = { ...accepted, expectsCompletionMessage: true };
    harnessMocks.runAttempt
      .mockResolvedValueOnce(makeEmbeddedRunnerAttempt({ acceptedSessionSpawns: [receipt] }))
      .mockResolvedValueOnce(makeEmbeddedRunnerAttempt({}))
      .mockResolvedValueOnce(makeEmbeddedRunnerAttempt({}));
    await runBackend({
      modelId: "first-model",
      admittedRunContext: { operationalRunInstance: instance },
    });
    const fallback = await runBackend({
      modelId: "second-model",
      admittedRunContext: { operationalRunInstance: instance },
    });
    const replacement = await runBackend({
      admittedRunContext: { operationalRunInstance: createOperationalRunInstanceRef("parent") },
    });
    expect(fallback.acceptedSessionSpawns).toEqual([receipt]);
    expect(replacement.acceptedSessionSpawns ?? []).toEqual([]);
  });

  it.each(["openclaw", "codex"])(
    "does not trust attempt-supplied settlement from %s",
    async (agentHarnessId) => {
      harnessMocks.runAttempt.mockResolvedValueOnce(
        makeEmbeddedRunnerAttempt({
          agentHarnessId,
          yieldDetected: true,
          requesterContinuationSettled: true,
          acceptedSessionSpawns: [accepted],
        }),
      );
      const result = await runBackend();
      expect(result.requesterContinuationSettled).toBeUndefined();
      expect(result.acceptedSessionSpawns).toEqual([accepted]);
    },
  );

  it.each([true, false])(
    "keeps runtime model selection only for prepared ownership (%s)",
    async (runtimeOwned) => {
      const selection = { provider: "native-provider", model: "native-model" };
      harnessMocks.runAttempt.mockResolvedValueOnce({
        agentHarnessId: "native-runtime",
        runtimeModelSelection: selection,
      });
      const nativeRuntime: NonNullable<Parameters<typeof runEmbeddedAttemptWithBackend>[1]> = {
        harness: {
          id: "native-runtime",
          label: "Native runtime",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unexpected direct harness call");
          },
        },
        auth: "native",
        assertCurrent: async () => {},
      };
      const result = await runBackend({}, runtimeOwned ? nativeRuntime : undefined);
      if (runtimeOwned) {
        expect(result).toMatchObject({ runtimeModelSelection: selection });
      } else {
        expect(result).not.toHaveProperty("runtimeModelSelection");
      }
    },
  );

  it("preserves core TTS delivery provenance through backend projection", async () => {
    const operationalRunInstance = {};
    const attempt = markCoreTtsAttemptResult(
      {
        agentHarnessId: "openclaw",
        toolMediaUrls: ["/tmp/reply.opus"],
      },
      ["/tmp/reply.opus"],
      operationalRunInstance,
    );
    harnessMocks.runAttempt.mockResolvedValueOnce(attempt);

    const result = await runBackend();

    expect(
      getCoreTtsAttemptResultMediaUrls(result, result.toolMediaUrls, operationalRunInstance),
    ).toEqual(["/tmp/reply.opus"]);
  });

  it.each([true, false])("projects runtime-owned auth provenance (%s)", async (owned) => {
    const credentialSource = owned
      ? ({ kind: "direct", evidence: "environment", authorization: "ambient" } as const)
      : undefined;
    harnessMocks.runAttempt.mockResolvedValueOnce({
      agentHarnessId: "openclaw",
      modelAttempt: {
        provider: "stale-provider",
        model: "stale-model",
        credentialSource: { kind: "profile" },
      },
    });

    const result = await runBackend({
      runtimePlan: {
        resolvedRef: { provider: "groq", modelId: "openai/gpt-oss-120b" },
        auth: credentialSource ? { credentialSource } : {},
      },
    });

    expect(result.modelAttempt).toEqual(
      credentialSource
        ? { provider: "groq", model: "openai/gpt-oss-120b", credentialSource }
        : undefined,
    );
  });
});

describe("workspace inputs at harness dispatch", () => {
  async function fixture(prepare: NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>) {
    const runId = randomUUID();
    const workspaceDir = `/tmp/remote-workspace-${runId}`;
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", state: "present", boundary: "workspace-attachments-test" },
      },
    });
    const admittedRunContext = await admission.admit("embedded");
    const release = registerAgentWorkspaceAccess(workspaceDir, {
      bridge: {
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => {},
        stat: async () => null,
      },
      prepareTurnAttachments: prepare,
    });
    onTestFinished(() => {
      release();
      admission.close();
    });
    return {
      params: {
        workspaceDir,
        admittedRunContext,
        prompt: "Inspect attachment",
        media: [{ path: "media://inbound/report.pdf" }],
        timeoutMs: 1_000,
      },
      admission,
      release,
    };
  }

  it("transfers canonical documents preserved by native image projection without a transcript recorder", async () => {
    const prepare = vi.fn<NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>>(
      async (_turn, assertCurrent) => {
        assertCurrent();
        expect(harnessMocks.runAttempt).not.toHaveBeenCalled();
        return "Read /remote/.inputs/report.pdf";
      },
    );
    const f = await fixture(prepare);
    const media = [{ path: "media://inbound/report.pdf", kind: "document" as const }];
    harnessMocks.runAttempt.mockResolvedValueOnce({ agentHarnessId: "codex" });
    const projected = await prepareEmbeddedAttemptPromptExecution({
      attempt: { ...f.params, media, model: { input: ["text", "image"] } },
      mediaOwnerAgentId: "main",
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: f.params.workspaceDir,
      prompt: "",
      skipPromptSubmission: false,
      pluginHarness: true,
    });
    expect(projected.media).toEqual(media);
    const params = { ...f.params, ...projected };
    await runEmbeddedAttemptWithBackend(params as never, undefined, media);
    expect(prepare.mock.calls[0]?.[0].media).toBe(media);
    const dispatched = harnessMocks.runAttempt.mock.calls[0]?.[0];
    expect(dispatched).toMatchObject({
      prompt: "Inspect attachment\n\nRead /remote/.inputs/report.pdf",
      transcriptPrompt: "Inspect attachment",
      media,
    });
    expect(dispatched.media).toBe(params.media);
    expect(params.prompt).toBe("Inspect attachment");
  });

  it.each(["failed", "revoked", "run-closed", "aborted"])(
    "does not dispatch attachments after preparation is %s",
    async (failure) => {
      const controller = new AbortController();
      const f = await fixture(async (_turn, assertCurrent) => {
        if (failure === "failed") {
          throw new Error("transfer unavailable");
        }
        if (failure === "revoked") {
          f.release();
        } else if (failure === "run-closed") {
          f.admission.close();
        } else {
          controller.abort(new Error("cancelled"));
        }
        expect(assertCurrent).toThrow();
        return "obsolete input directory";
      });
      await expect(runBackend({ ...f.params, abortSignal: controller.signal })).rejects.toThrow();
      expect(harnessMocks.runAttempt).not.toHaveBeenCalled();
    },
  );
});
