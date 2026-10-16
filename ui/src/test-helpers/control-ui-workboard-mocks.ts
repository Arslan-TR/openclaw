import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { ControlUiMockRequestHandler } from "./control-ui-e2e-contract.ts";
import type { ControlUiMockGateway } from "./control-ui-e2e.ts";
import type { buildWorkboardMocks } from "./control-ui-workboard-fixtures.ts";

// The launcher serializes this installer into the browser; keep it free of module captures.
export function installWorkboardBoardMock(seed: ReturnType<typeof buildWorkboardMocks>): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const workboardBoards = new Map<string, Record<string, unknown>>(
    seed.boards.map((board) => [board.id, board]),
  );
  type MockCard = (typeof seed.cards)[number] & {
    metadata: {
      automation: { boardId: string };
      templateId?: string;
      archivedAt?: number;
      links?: NonNullable<WorkboardCard["metadata"]>["links"];
      comments?: { id: string; body: string; createdAt: number }[];
    };
    notes?: string;
    agentId?: string;
    sessionKey?: string;
    events?: { id: string; kind: string; at: number; fromStatus?: string; toStatus?: string }[];
    completedAt?: number;
  };
  function revisionError(card: MockCard | undefined, expectedUpdatedAt: unknown) {
    if (
      expectedUpdatedAt !== undefined &&
      (typeof expectedUpdatedAt !== "number" || !Number.isFinite(expectedUpdatedAt))
    ) {
      return { code: "workboard_error", message: "expectedUpdatedAt must be a finite number." };
    }
    if (card && expectedUpdatedAt !== undefined && expectedUpdatedAt !== card.updatedAt) {
      return {
        code: "workboard_conflict",
        message: "Card changed while you were editing. Review the latest values and retry.",
        details: { type: "workboard_card_conflict", card },
      };
    }
    return undefined;
  }
  const workboardCards = new Map<string, MockCard>(seed.cards.map((card) => [card.id, card]));
  const statuses = seed.methodResponses["workboard.cards.list"].statuses;
  let revision = Date.now();
  type Request = Parameters<ControlUiMockRequestHandler>[0];
  const invalid = (respond: Request["respond"], message: string) =>
    respond({ __mockError: { code: "INVALID_REQUEST", message } });
  const appendEvent = (
    card: MockCard | undefined,
    id: string,
    kind: string,
    at: number,
    transition: { fromStatus?: string; toStatus?: string } = {},
  ) => [...(card?.events ?? []), { id, kind, at, ...transition }].slice(-50);
  const summarize = (cards: MockCard[]) => {
    const archived = cards.filter((card) => Boolean(card.metadata.archivedAt)).length;
    return {
      total: cards.length,
      active: cards.length - archived,
      archived,
      byStatus: Object.fromEntries(
        statuses.map((status) => [status, cards.filter((card) => card.status === status).length]),
      ),
    };
  };
  const boardSummaries = () =>
    [...workboardBoards.values()].map((board) => {
      const cards = [...workboardCards.values()].filter(
        (card) => card.metadata.automation.boardId === board.id,
      );
      return Object.assign({}, board, {
        id: board.id,
        ...summarize(cards),
        updatedAt: Math.max(Number(board.updatedAt ?? 0), ...cards.map((card) => card.updatedAt)),
      });
    });
  gateway.setRequestHandler("workboard.boards.list", ({ respond }) => {
    respond({ boards: boardSummaries() });
  });
  gateway.setRequestHandler("workboard.cards.list", ({ respond }) => {
    respond({
      statuses,
      cards: [...workboardCards.values()].toSorted(
        (left, right) =>
          statuses.indexOf(left.status) - statuses.indexOf(right.status) ||
          left.position - right.position ||
          left.createdAt - right.createdAt,
      ),
      boards: boardSummaries(),
    });
  });
  gateway.setRequestHandler("workboard.cards.stats", ({ params, respond }) => {
    const input = params as { boardId?: unknown };
    const boardId = typeof input?.boardId === "string" ? input.boardId.trim() : "";
    const cards = [...workboardCards.values()].filter(
      (card) => !boardId || card.metadata.automation.boardId === boardId,
    );
    const byAgent = new Map<string, number>();
    for (const card of cards) {
      const agentId = card.agentId || "(default)";
      byAgent.set(agentId, (byAgent.get(agentId) ?? 0) + 1);
    }
    const ready = cards.filter((card) => card.status === "ready" && !card.metadata.archivedAt);
    respond({
      id: boardId || "all",
      ...summarize(cards),
      byAgent: Object.fromEntries(byAgent),
      ...(cards.length ? { updatedAt: Math.max(...cards.map((card) => card.updatedAt)) } : {}),
      ...(ready.length
        ? {
            oldestReadyAgeMs: Math.max(
              0,
              Date.now() - Math.min(...ready.map((card) => card.updatedAt)),
            ),
          }
        : {}),
    });
  });
  for (const method of ["workboard.cards.create", "workboard.cards.update"]) {
    gateway.setRequestHandler(method, ({ params, respond, emit }) => {
      const input = params as {
        id?: string;
        patch?: Partial<MockCard>;
        expectedUpdatedAt?: number;
        boardId?: string;
        templateId?: string;
      } & Partial<MockCard>;
      const updating = method === "workboard.cards.update";
      const existing = updating && input.id ? workboardCards.get(input.id) : undefined;
      const patch = updating ? (input.patch ?? {}) : input;
      if ((updating && !existing) || !(patch.title ?? existing?.title)?.trim()) {
        return invalid(respond, "A valid card and title are required.");
      }
      const conflict = revisionError(existing, input.expectedUpdatedAt);
      if (conflict) {
        return respond({ __mockError: conflict });
      }
      const now = existing ? Math.max(Date.now(), existing.updatedAt + 1) : Date.now();
      const boardId = existing?.metadata.automation.boardId ?? input.boardId ?? "default";
      const status = patch.status ?? existing?.status ?? "todo";
      if (!statuses.includes(status)) {
        return invalid(respond, "Unknown card status.");
      }
      const card: MockCard = {
        ...existing,
        id: existing?.id ?? `mock-card-${++revision}`,
        title: (patch.title ?? existing?.title ?? "").trim(),
        notes: patch.notes ?? existing?.notes ?? "",
        priority: patch.priority ?? existing?.priority ?? "normal",
        labels: patch.labels ?? existing?.labels ?? [],
        agentId: patch.agentId ?? existing?.agentId ?? "",
        sessionKey: patch.sessionKey ?? existing?.sessionKey ?? "",
        status,
        position:
          patch.position ??
          existing?.position ??
          Math.max(
            0,
            ...[...workboardCards.values()]
              .filter(
                (entry) => entry.status === status && entry.metadata.automation.boardId === boardId,
              )
              .map((entry) => entry.position),
          ) + 1000,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        metadata: existing?.metadata ?? {
          automation: { boardId },
          ...(input.templateId ? { templateId: input.templateId } : {}),
        },
        events: appendEvent(
          existing,
          `mock-edit-${++revision}`,
          updating ? "edited" : "created",
          now,
        ),
      };
      if (!workboardBoards.has(boardId)) {
        workboardBoards.set(boardId, { id: boardId, updatedAt: now });
      }
      workboardCards.set(card.id, card);
      respond({ card });
      emit("plugin.workboard.changed", { epoch: "workboard-mock", revision });
    });
  }
  gateway.setRequestHandler("workboard.cards.comment", ({ params, respond, emit }) => {
    const input = params as { id: string; body?: string };
    const card = workboardCards.get(input.id);
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!card || !body || body.length > 2000) {
      return invalid(
        respond,
        !card
          ? "Unknown card."
          : !body
            ? "Comment body is required."
            : "Comment body must be 2000 characters or fewer.",
      );
    }
    const now = Date.now();
    const comment = { id: `mock-comment-${++revision}`, body, createdAt: now };
    const updated: MockCard = {
      ...card,
      updatedAt: now,
      metadata: {
        ...card.metadata,
        comments: [...(card.metadata.comments ?? []), comment].slice(-50),
      },
      events: appendEvent(card, `mock-comment-event-${revision}`, "comment_added", now),
    };
    workboardCards.set(card.id, updated);
    respond({ card: updated });
    emit("plugin.workboard.changed", { epoch: "workboard-mock", revision });
  });
  gateway.setRequestHandler("workboard.cards.archive", ({ params, respond, emit }) => {
    const input = params as { id: string; expectedUpdatedAt?: number; archived?: boolean };
    const card = workboardCards.get(input.id);
    if (!card) {
      return invalid(respond, "Unknown card.");
    }
    const conflict = revisionError(card, input.expectedUpdatedAt);
    if (conflict) {
      return respond({ __mockError: conflict });
    }
    const now = Math.max(Date.now(), card.updatedAt + 1);
    const archived = input.archived !== false;
    const updated: MockCard = {
      ...card,
      updatedAt: now,
      metadata: { ...card.metadata, archivedAt: archived ? now : 0 },
      events: appendEvent(
        card,
        `mock-archive-${++revision}`,
        archived ? "archived" : "unarchived",
        now,
      ),
    };
    workboardCards.set(card.id, updated);
    respond({ card: updated });
    emit("plugin.workboard.changed", { epoch: "workboard-mock", revision });
  });
  gateway.setRequestHandler("workboard.cards.delete", ({ params, respond, emit }) => {
    const input = params as { id: string; expectedUpdatedAt?: number };
    const conflict = revisionError(workboardCards.get(input.id), input.expectedUpdatedAt);
    if (conflict) {
      return respond({ __mockError: conflict });
    }
    const deleted = workboardCards.delete(input.id);
    const referenceUpdates: Array<{ id: string; previousUpdatedAt: number; updatedAt: number }> =
      [];
    if (deleted) {
      for (const card of workboardCards.values()) {
        const { links, ...metadata } = card.metadata;
        if (!links?.some((link) => link.targetCardId === input.id)) {
          continue;
        }
        const updatedAt = Math.max(Date.now(), card.updatedAt + 1);
        const remainingLinks = links.filter((link) => link.targetCardId !== input.id);
        workboardCards.set(card.id, {
          ...card,
          updatedAt,
          metadata: { ...metadata, ...(remainingLinks.length ? { links: remainingLinks } : {}) },
        });
        referenceUpdates.push({ id: card.id, previousUpdatedAt: card.updatedAt, updatedAt });
      }
    }
    respond({ deleted, ...(referenceUpdates.length ? { referenceUpdates } : {}) });
    if (deleted) {
      emit("plugin.workboard.changed", { epoch: "workboard-mock", revision: ++revision });
    }
  });
  gateway.setRequestHandler("workboard.cards.move", ({ params, respond, emit }) => {
    const input = params as {
      id: string;
      expectedUpdatedAt?: number;
      status: string;
      position?: number;
    };
    const card = workboardCards.get(input.id);
    if (!card || !statuses.includes(input.status)) {
      return invalid(respond, "Unknown card or status.");
    }
    const conflict = revisionError(card, input.expectedUpdatedAt);
    if (conflict) {
      return respond({ __mockError: conflict });
    }
    const now = Math.max(Date.now(), card.updatedAt + 1);
    const moved: MockCard = {
      ...card,
      status: input.status,
      position: input.position ?? card.position,
      updatedAt: now,
      completedAt: input.status === "done" ? now : undefined,
      events: appendEvent(card, `mock-move-${++revision}`, "moved", now, {
        fromStatus: card.status,
        toStatus: input.status,
      }),
    };
    workboardCards.set(card.id, moved);
    respond({ card: moved });
    emit("plugin.workboard.changed", { epoch: "workboard-mock", revision });
  });
  gateway.setRequestHandler("workboard.boards.upsert", ({ params, respond, emit }) => {
    const input = params as Record<string, unknown>;
    const clearAppearance = input.clearAppearance === undefined ? [] : input.clearAppearance;
    if (
      !Array.isArray(clearAppearance) ||
      clearAppearance.some((field) => field !== "icon" && field !== "color")
    ) {
      return invalid(respond, "clearAppearance must be an array containing only icon or color.");
    }
    const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "default";
    const board: Record<string, unknown> = {
      ...workboardBoards.get(id),
      id,
      updatedAt: Date.now(),
    };
    for (const [key, value] of Object.entries(input)) {
      if (key === "id" || key === "clearAppearance") {
        continue;
      }
      if (key === "icon" || key === "color") {
        if (typeof value === "string" && value.trim()) {
          board[key] = value.trim();
        }
      } else if (value !== undefined && value !== "") {
        Object.assign(board, { [key]: typeof value === "string" ? value.trim() : value });
      }
    }
    for (const field of clearAppearance) {
      delete board[field];
    }
    workboardBoards.set(id, board);
    respond({ board });
    emit("plugin.workboard.changed", { epoch: "workboard-mock", revision: ++revision });
  });
}
