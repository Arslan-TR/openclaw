import type { CronJob } from "../api/types.ts";
import {
  createControlUiChatHistoryMessage as chatHistoryMessage,
  createControlUiMockSessionRow as sessionRow,
} from "./control-ui-session-fixtures.ts";
import { buildWorkboardProgressResponses } from "./control-ui-workboard-progress-fixtures.ts";
import {
  buildWorkboardStateCells,
  buildWorkboardStateSessions,
  MATRIX_STATES,
} from "./control-ui-workboard-states.ts";
import { cronListResponseFixture } from "./cron.ts";

export function buildWorkboardMocks(
  baseTime: number,
  actor: { id: string; label: string },
  matrix = false,
) {
  const matrixCells = matrix ? buildWorkboardStateCells(baseTime) : [];
  const boardId = "peter-tasks";
  const briefSessionKey = "agent:main:workboard-brief";
  const launchSessionKey = "agent:main:workboard-launch";
  const stagingSessionKey = "agent:main:workboard-staging";
  const handoffSessionKey = "agent:main:workboard-handoff";
  const onboardingSessionKey = "agent:main:workboard-onboarding";
  const accessibilitySessionKey = "agent:main:workboard-accessibility";
  const inFlightRun = {
    runId: "workboard-onboarding-run",
    text: "Checking first-task navigation and recovery after a validation error…",
    startedAt: baseTime - 8 * 60_000,
    events: [],
  };
  const card = (
    id: string,
    title: string,
    status: string,
    priority: string,
    position: number,
    labels: string[],
    sessionKey?: string,
  ) => ({
    id,
    title,
    status,
    priority,
    labels,
    notes: "",
    sessionKey,
    position,
    createdAt: baseTime - 86_400_000,
    updatedAt: baseTime - position * 1_000,
    metadata: { automation: { boardId } },
  });
  const cards = [
    card("card-inbox", "Capture customer feedback themes", "todo", "normal", 1, ["research"]),
    ...(
      [
        ["brief", "Draft weekly product brief", "todo", "low", 2, "writing", briefSessionKey],
        ["ready", "Launch readiness", "ready", "high", 1, "launch", launchSessionKey],
        ["running", "Onboarding", "running", "urgent", 1, "quality", onboardingSessionKey],
        ["review", "Accessibility audit", "review", "high", 1, "frontend", accessibilitySessionKey],
        ["blocked", "Staging access", "blocked", "normal", 1, "ops", stagingSessionKey],
        ["done", "Publish support handoff notes", "done", "low", 1, "docs", handoffSessionKey],
      ] as const
    ).map(([id, title, status, priority, position, label, key]) =>
      card(`card-${id}`, title, status, priority, position, [label], key),
    ),
  ];
  const statuses = ["todo", "ready", "running", "review", "blocked", "done"];
  const summarizeBoard = (entries: readonly { status: string }[]) => ({
    total: entries.length,
    active: entries.length,
    archived: 0,
    byStatus: Object.fromEntries(
      statuses.map((status) => [status, entries.filter((entry) => entry.status === status).length]),
    ),
    updatedAt: baseTime,
  });
  const board = {
    id: boardId,
    name: "Product Operations",
    description: "Shared product delivery queue",
    automationJobId: "job-product-operations-daily",
    ...summarizeBoard(cards),
  };
  const stateCard = (
    id: string,
    title: string,
    status: string,
    position = 1000,
    session = true,
  ) => ({
    ...card(
      `state-${id}`,
      title,
      status,
      "normal",
      position,
      ["synthetic"],
      session ? `agent:main:card-states-${id}` : undefined,
    ),
    metadata: { automation: { boardId: "card-states" } },
  });
  const proof = (id: string, status: string, age: number) => ({
    id,
    status,
    label: "Synthetic accessibility review",
    note: "Illustrative evidence only; no test was executed.",
    createdAt: baseTime - age,
  });
  const attempt = (id: string, status: string, start: number, end: number, error?: string) => ({
    id,
    status,
    startedAt: baseTime - start,
    endedAt: baseTime - end,
    ...(error ? { error } : {}),
  });
  const notification = (id: string, kind: string, runId: string, age: number) => ({
    id: `state-${id}`,
    kind,
    runId: `state-${runId}`,
    createdAt: baseTime - age,
    message: `Synthetic ${kind} notification.`,
  });
  const stateCards = [
    {
      ...stateCard(
        "rich",
        "Review the complete release handoff, including accessibility findings, localization notes, and the final owner checklist ✨",
        "review",
      ),
      priority: "high",
      labels: [
        "release",
        "long-label-for-layout-coverage-without-any-spaces",
        "アクセシビリティ ✨",
        "localization",
        "owner-review",
      ],
      notes:
        "Synthetic design fixture. Review the handoff as a complete package.\n\nCheck keyboard navigation, translated strings, empty states, and the operator recovery path. Preserve context when opening supporting evidence.",
      metadata: {
        automation: { boardId: "card-states" },
        templateId: "release",
        comments: [
          {
            id: "state-comment",
            body: "The first pass is ready. Please verify the recovery instructions before signing off.",
            createdAt: baseTime - 180_000,
          },
        ],
        proof: [
          proof("state-proof-failed", "failed", 1_000_000),
          proof("state-proof-skipped", "skipped", 150_000),
          proof("state-proof", "passed", 120_000),
        ],
        failureCount: 1,
        attempts: [
          attempt("state-first-attempt", "failed", 1_200_000, 1_000_000, "Synthetic failure."),
          attempt("state-attempt", "succeeded", 900_000, 240_000),
        ],
        claim: {
          ownerId: "main",
          token: "synthetic-claim",
          claimedAt: baseTime - 900_000,
          lastHeartbeatAt: baseTime - 240_000,
        },
      },
    },
    {
      ...stateCard(
        "dependency",
        "Publish the release after the handoff is approved",
        "blocked",
        1000,
        false,
      ),
      agentId: "release-reviewer",
      metadata: {
        automation: { boardId: "card-states" },
        links: [
          {
            id: "state-parent",
            type: "parent",
            targetCardId: "state-rich",
            createdAt: baseTime - 600_000,
          },
        ],
        workerProtocol: {
          state: "blocked",
          detail: "Waiting for the release owner to approve the handoff.",
          updatedAt: baseTime - 120_000,
        },
        diagnostics: [
          {
            kind: "missing_proof",
            severity: "critical",
            title: "Release verification is missing",
            detail: "Attach the final deployment verification before publishing.",
            firstSeenAt: baseTime - 600_000,
            lastSeenAt: baseTime - 120_000,
            count: 1,
            actions: [],
          },
        ],
      },
    },
    {
      ...stateCard("stale", "Investigate a run with no recent session activity", "running"),
      labels: [],
      metadata: {
        automation: { boardId: "card-states" },
        stale: {
          detectedAt: baseTime - 60_000,
          lastSessionUpdatedAt: baseTime - 45 * 60_000,
          reason: "The synthetic session has not reported activity for 45 minutes.",
        },
      },
    },
    stateCard("missing", "Reconnect a session that is absent from the directory", "todo"),
    stateCard("queued", "Wait for the task worker to accept the request", "ready"),
    stateCard("running", "Collect the remaining release checklist findings", "running", 2000),
    stateCard("timeout", "Retry the environment check after its deadline", "blocked", 2000),
    stateCard("stopped", "Resume a task stopped by the operator", "blocked", 3000),
    stateCard("completed", "Review a completed background task", "review", 2000),
    {
      ...stateCard("failed", "Inspect a failed task", "blocked", 4000),
      runId: "state-current-failed-run",
      metadata: {
        automation: { boardId: "card-states" },
        notifications: [
          notification("current-failure", "failed", "current-failed-run", 60_000),
          notification("old-completion", "completed", "previous-run", 30_000),
        ],
      },
    },
    {
      ...stateCard("ambiguous", "Choose a shared-session owner", "todo", 2000),
      sessionKey: "global",
    },
  ];
  const allCards = matrix
    ? [
        ...matrixCells.map((cell) => cell.card),
        ...stateCards.filter((entry) => entry.id === "state-stale"),
      ]
    : [...cards, ...stateCards];
  const statesBoard = {
    id: "card-states",
    name: "Card states",
    description: "Synthetic examples of card content and execution states",
    ...summarizeBoard(stateCards),
  };
  const boards = matrix
    ? [
        ...MATRIX_STATES.map((state) =>
          Object.assign(
            {
              id: `matrix-${state}`,
              name: `Matrix · ${state}`,
              description: "Synthetic card presentation matrix",
            },
            summarizeBoard(
              matrixCells.filter((cell) => cell.state === state).map((cell) => cell.card),
            ),
          ),
        ),
        { ...statesBoard, name: "Natural stale regression", total: 1, active: 1 },
      ]
    : [board, statesBoard];
  const automationJob: CronJob = {
    id: board.automationJobId,
    agentId: "main",
    name: "Review product operations",
    description:
      "Review this board and summarize priorities, blockers, and work ready for handoff.",
    enabled: true,
    createdAtMs: baseTime - 86_400_000,
    updatedAtMs: baseTime,
    schedule: { kind: "every", everyMs: 86_400_000, anchorMs: baseTime },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message:
        "Review the peter-tasks Workboard. Summarize current priorities and blockers without starting new work.",
    },
    delivery: { mode: "none" },
    state: { nextRunAtMs: baseTime + 86_400_000 },
  };
  const sessionKey = "agent:main:workboard-proof";
  const cardSessions = [
    sessionRow(briefSessionKey, "Weekly product brief", baseTime - 2 * 60_000, {
      status: "queued",
    }),
    sessionRow(launchSessionKey, "Launch readiness", baseTime - 12 * 60_000, {
      status: undefined,
      totalTokens: 2_400,
    }),
    sessionRow(stagingSessionKey, "Staging access", baseTime - 5 * 60_000, {
      status: "failed",
      totalTokens: 1_800,
    }),
    sessionRow(handoffSessionKey, "Support handoff", baseTime - 30 * 60_000, {
      totalTokens: 4_200,
    }),
    sessionRow(onboardingSessionKey, "Onboarding validation", baseTime, {
      status: "running",
      hasActiveRun: true,
      activeRunIds: [inFlightRun.runId],
      startedAt: inFlightRun.startedAt,
      totalTokens: 12_400,
    }),
    sessionRow(accessibilitySessionKey, "Accessibility audit", baseTime - 3 * 60_000, {
      totalTokens: 8_600,
    }),
  ];
  cardSessions.push(
    sessionRow("agent:main:card-states-rich", "Release handoff review", baseTime - 240_000),
    sessionRow("agent:main:card-states-stale", "Release investigation", baseTime - 45 * 60_000, {
      status: "running",
    }),
    ...(["queued", "running", "timeout", "stopped", "completed", "failed"] as const).map((state) =>
      sessionRow(
        `agent:main:card-states-${state}`,
        `Synthetic ${state} session`,
        baseTime - 60_000,
        {
          status: state === "stopped" ? "killed" : state === "completed" ? "done" : state,
          hasActiveRun: state === "running",
        },
      ),
    ),
  );
  if (matrix) {
    cardSessions.splice(0, cardSessions.length, ...buildWorkboardStateSessions(baseTime));
  }
  type HistoryMessage = ReturnType<typeof chatHistoryMessage> & {
    __openclaw?: { senderId: string; senderName: string };
  };
  const timelines: [key: string, userAge: number, assistantAge?: number][] = [
    ...cardSessions
      .filter((session) => session.key.includes(":card-states-"))
      .map((session): [string, number] => [session.key, 700_000]),
    [briefSessionKey, 2 * 60_000],
    [launchSessionKey, 15 * 60_000, 12 * 60_000],
    [stagingSessionKey, 7 * 60_000, 5 * 60_000],
    [handoffSessionKey, 40 * 60_000, 30 * 60_000],
    [onboardingSessionKey, 8 * 60_000, 60_000],
    [accessibilitySessionKey, 20 * 60_000, 3 * 60_000],
  ];
  const cardSessionHistories = Object.fromEntries(
    timelines.map(([key, userAge, assistantAge]) => {
      const user = chatHistoryMessage(
        "user",
        "Review this task and its recorded outcome.",
        baseTime - userAge,
      );
      Object.assign(user, { __openclaw: { senderId: actor.id, senderName: actor.label } });
      const messages: HistoryMessage[] = [user];
      if (assistantAge !== undefined) {
        const text =
          key === stagingSessionKey
            ? "Staging access failed: HTTP 403. Restore access before retrying."
            : key === onboardingSessionKey
              ? "Checking first-task navigation and recovery."
              : key === launchSessionKey
                ? "The checklist is ready. Share the release scope to continue."
                : key === handoffSessionKey
                  ? "The support handoff notes are complete and published."
                  : "The accessibility review is complete.";
        messages.push(chatHistoryMessage("assistant", text, baseTime - assistantAge));
      }
      return [key, { messages, ...(key === onboardingSessionKey ? { inFlightRun } : {}) }];
    }),
  );
  return {
    board,
    boards,
    cards: allCards,
    sessionKey,
    cardSessions,
    cardSessionHistories,
    methodResponses: {
      "agents.list": {
        agents: [
          { id: "main", name: "Molty", identity: { name: "Molty" } },
          {
            id: "release-reviewer",
            name: "Release reviewer",
            identity: { name: "Release reviewer" },
          },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "global",
      },
      "cron.get": {
        cases: [
          { match: { id: automationJob.id }, response: automationJob },
          {
            response: {
              __mockError: { code: "INVALID_REQUEST", message: "Mock automation not found." },
            },
          },
        ],
      },
      "cron.list": cronListResponseFixture({
        jobs: [automationJob],
        snapshotRevision: "workboard-mock-cron",
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      }),

      "board.get": {
        sessionKey,
        revision: 1,
        tabs: [{ tabId: "main", title: "Workboard", position: 0, chatDock: "hidden" }],
        widgets: [
          {
            name: "session-progress",
            tabId: "main",
            title: "Session progress",
            contentKind: "plugin",
            pluginKind: "session:progress",
            sizeW: 6,
            sizeH: 5,
            position: 0,
            grantState: "none",
            revision: 1,
          },
          {
            name: "workboard-product-operations",
            tabId: "main",
            title: "Product Operations",
            contentKind: "plugin",
            pluginKind: "workboard:board",
            props: { boardId },
            heightMode: "fixed",
            sizeW: 12,
            sizeH: 16,
            position: 1,
            grantState: "none",
            revision: 1,
          },
        ],
      },
      "workboard.boards.list": { boards },
      "workboard.cards.list": { boards, cards: allCards, statuses },
      "workboard.cards.stats": { ...board, byAgent: {} },
      "workboard.cards.move": { card: cards[0] },
      "progressCard.get": buildWorkboardProgressResponses(baseTime, sessionKey, cardSessions),
    },
  };
}
