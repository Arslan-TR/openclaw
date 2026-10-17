import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatThreadDistanceFromBottom, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureTopVisibleVirtualRow } from "./virtual-row-anchor.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI transcript disclosure anchoring",
  startServerBeforeBrowser: true,
});

const textBlock = (text: string) => ({ type: "text", text });
function message(role: string, content: unknown, timestamp: number) {
  return { role, content, timestamp };
}
const assistant = (content: string | unknown[], timestamp: number) =>
  message("assistant", typeof content === "string" ? [textBlock(content)] : content, timestamp);
const rows = (count: number, text: (n: number) => string) =>
  Array.from({ length: count }, (_, index) => text(index + 1));
const prettyJson = (data: unknown) => JSON.stringify(data, null, 2);
function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}
function toolResult(toolCallId: string, toolName: string, text: string, timestamp: number) {
  return { ...message("toolResult", [textBlock(text)], timestamp), toolCallId, toolName };
}

function makeTranscript(count: number, start = 1) {
  return Array.from({ length: count }, (_, index) => [
    message(
      "user",
      `Earlier prompt ${index + 1}: ${"Keep this transcript scrollable. ".repeat(3)}`,
      start + index * 2,
    ),
    assistant(`Earlier response ${index + 1}.`, start + index * 2 + 1),
  ]).flat();
}

async function createDisclosurePage(height: number, width: number) {
  const context = await suite.browser.newContext({
    reducedMotion: "reduce",
    viewport: { height, width },
  });
  return { context, page: await context.newPage() };
}

async function centerDisclosure(control: Locator) {
  await control.evaluate((button) => {
    const row = button.closest<HTMLElement>(".chat-virtual-row");
    const thread = button.closest<HTMLElement>(".chat-thread");
    if (!row || !thread) {
      throw new Error("Expected disclosure inside a virtual transcript row");
    }
    const rowTop = row.getBoundingClientRect().top - thread.getBoundingClientRect().top;
    thread.scrollTop += Math.round(rowTop - thread.clientHeight / 2);
  });
  await waitForChatScrollIdle(control.page());
}

function measureRow(element: Element, nextId?: string) {
  const row = element.closest<HTMLElement>(".chat-virtual-row")!;
  const scroller = row.closest<HTMLElement>(".chat-thread")!;
  const rect = row.getBoundingClientRect();
  const viewport = scroller.getBoundingClientRect();
  const nextTop = nextId
    ? scroller
        .querySelector(`.chat-bubble[data-entry-id="${nextId}"]`)!
        .closest(".chat-virtual-row")!
        .getBoundingClientRect().top
    : rect.bottom;
  return {
    key: row.dataset.virtualRowKey,
    height: row.offsetHeight,
    top: rect.top,
    bottom: rect.bottom,
    viewportTop: viewport.top,
    viewportBottom: viewport.bottom,
    nextTop,
    gap: nextTop - rect.bottom,
    returnOffset: scroller.scrollTop + rect.top - viewport.top,
  };
}

async function saveJson(directory: string, name: string, data: unknown) {
  await fs.writeFile(path.join(directory, `${name}.json`), `${prettyJson(data)}\n`);
}

type DisclosureFrame = {
  expanded: boolean;
  rowHeight: number;
  rowTop: number;
  scrollHeight: number;
  scrollTop: number;
};

async function traceDisclosure(
  summary: Locator,
  actionSelector?: string,
): Promise<DisclosureFrame[]> {
  return await summary.evaluate((button, selector) => {
    const row = button.closest<HTMLElement>(".chat-virtual-row");
    const thread = button.closest<HTMLElement>(".chat-thread");
    if (!row || !thread) {
      throw new Error("Expected disclosure inside a virtual transcript row");
    }
    const frames: DisclosureFrame[] = [];
    const sample = () => {
      frames.push({
        expanded: button.matches("summary")
          ? button.closest("details")?.hasAttribute("open") === true
          : button.getAttribute("aria-expanded") === "true" ||
            button.getAttribute("aria-pressed") === "true",
        rowHeight: row.getBoundingClientRect().height,
        rowTop: row.getBoundingClientRect().top - thread.getBoundingClientRect().top,
        scrollHeight: thread.scrollHeight,
        scrollTop: thread.scrollTop,
      });
    };
    sample();
    const action = selector ? row.querySelector<HTMLElement>(selector) : (button as HTMLElement);
    if (!action) {
      throw new Error(`Expected disclosure action ${selector}`);
    }
    action.click();
    return new Promise<DisclosureFrame[]>((resolve) => {
      let remaining = 8;
      const next = () => {
        sample();
        remaining -= 1;
        if (remaining === 0) {
          resolve(frames);
        } else {
          requestAnimationFrame(next);
        }
      };
      requestAnimationFrame(next);
    });
  }, actionSelector);
}

function expectStableFrames(frames: DisclosureFrame[], label = "disclosure") {
  const initial = frames[0];
  expect(initial).toBeDefined();
  expect(frames.at(-1)?.expanded, `${label} state`).toBe(!initial!.expanded);
  const resized = frames.some(
    ({ rowHeight, scrollHeight }) =>
      Math.abs(rowHeight - initial!.rowHeight) > 0.5 || scrollHeight !== initial!.scrollHeight,
  );
  expect(resized, `${label} resize`).toBe(true);
  const drift = frames.flatMap(({ rowTop, scrollTop }) => [
    Math.abs(rowTop - initial!.rowTop),
    Math.abs(scrollTop - initial!.scrollTop),
  ]);
  expect(
    Math.max(...drift),
    `${label} geometry and scroll offset: ${JSON.stringify(frames)}`,
  ).toBeLessThanOrEqual(2);
}

async function showSplitDashboard(page: Page, sessionKey: string) {
  const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, settingsKey }) => {
      const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Record<
        string,
        unknown
      >;
      settings.boardSessionViews = { [key]: { activeTabId: "main" } };
      localStorage.setItem(settingsKey, JSON.stringify(settings));
    },
    { key: sessionKey, settingsKey: storageKey },
  );
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
  await page.locator(".chat-pane-primary-column .chat-thread").waitFor();
}

async function checkRecovery(
  reducedMotion: "no-preference" | "reduce",
  interruption: "wheel" | "synthetic-pointer" | "native-pointer",
  recoveryPosition: "within-viewport" | "above-viewport",
) {
  const artifactDir = path.join(
    createControlUiE2eArtifactDir(
      "virtual-sizing",
      process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR,
    ),
    "after",
    `${reducedMotion}-${interruption}-${recoveryPosition}`,
  );
  await suite.withPage(
    {
      reducedMotion,
      viewport: { width: 1440, height: 900 },
    },
    async ({ page }) => {
      await page.clock.install();
      const gateway = await installMockGateway(page, {
        heldMethods: ["chat.message.get"],
        historyMessages: Array.from({ length: 60 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content:
            index === 1
              ? "Assistant preview awaiting full text."
              : `Transcript message ${index}. ${"Keep this conversation scrollable. ".repeat(6)}`,
          timestamp: 1000 + index,
          __openclaw: {
            id: `sizing-message-${index}`,
            seq: index + 1,
            ...(index % 2 === 1 ? { truncated: true, reason: "display-cap" } : {}),
          },
        })),
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Transcript message 59.", { exact: false }).waitFor();
      await waitForChatScrollIdle(page);
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      await thread.hover();
      await page.mouse.wheel(0, -100_000);
      await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
      await gateway.waitForRequest("chat.message.get");
      await waitForChatScrollIdle(page);
      await page
        .locator('.chat-bubble[data-entry-id="sizing-message-1"]')
        .waitFor({ state: "visible" });
      let during: { top: number; max: number };
      if (interruption === "synthetic-pointer") {
        // Interrupt during native scroll; a Node round trip can outlive the row's visible range.
        during = await page.locator(".chat-scroll-to-bottom").evaluate((button, waitTimeout) => {
          const scroller = document.querySelector<HTMLElement>(
            ".chat-pane-cache__pane--active .chat-thread",
          )!;
          return new Promise<{ top: number; max: number }>((resolve, reject) => {
            const interrupt = (event: Event) => {
              if (!event.isTrusted || scroller.scrollTop <= 0) {
                return;
              }
              clearTimeout(timer);
              scroller.removeEventListener("scroll", interrupt);
              const position = {
                top: scroller.scrollTop,
                max: scroller.scrollHeight - scroller.clientHeight,
              };
              scroller.dispatchEvent(
                new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
              );
              resolve(position);
            };
            const timer = setTimeout(() => {
              scroller.removeEventListener("scroll", interrupt);
              reject(new Error("Native scrolling did not reach the interruption geometry"));
            }, waitTimeout);
            scroller.addEventListener("scroll", interrupt);
            (button as HTMLElement).click();
          });
        }, controlUiE2eWaitTimeoutMs);
      } else {
        const wheel = interruption === "wheel";
        const track = await thread.boundingBox();
        expect(track).not.toBeNull();
        const input = await thread.evaluateHandle(
          (scroller, { waitTimeout, wheel: isWheel }) => {
            const eventType = isWheel ? "wheel" : "pointerdown";
            const pendingAboveReader = () => {
              const viewportTop = scroller.getBoundingClientRect().top;
              const bubble = Array.from(
                scroller.querySelectorAll<HTMLElement>(
                  '.chat-bubble[data-entry-id^="sizing-message-"]',
                ),
              ).findLast(
                (candidate) =>
                  Number(candidate.dataset.entryId!.slice("sizing-message-".length)) % 2 === 1 &&
                  candidate.closest(".chat-virtual-row")!.getBoundingClientRect().bottom <=
                    viewportTop,
              );
              return bubble
                ? {
                    messageId: bubble.dataset.entryId!,
                    bottom: bubble.closest(".chat-virtual-row")!.getBoundingClientRect().bottom,
                    viewportTop,
                  }
                : null;
            };
            type InputArrival = {
              top: number;
              max: number;
              trusted: boolean;
              scroller: boolean;
              pending: ReturnType<typeof pendingAboveReader>;
            };
            let resolveReady!: (position: Pick<InputArrival, "top" | "max">) => void;
            let rejectReady!: (error: Error) => void;
            const ready = new Promise<Pick<InputArrival, "top" | "max">>((resolve, reject) => {
              resolveReady = resolve;
              rejectReady = reject;
            });
            let resolveArrival!: (arrival: InputArrival) => void;
            let rejectArrival!: (error: Error) => void;
            const arrived = new Promise<InputArrival>((resolve, reject) => {
              resolveArrival = resolve;
              rejectArrival = reject;
            });
            const onScroll = (event: Event) => {
              if (
                !event.isTrusted ||
                scroller.scrollTop <= 0 ||
                (!isWheel && !pendingAboveReader())
              ) {
                return;
              }
              scroller.removeEventListener("scroll", onScroll);
              document.addEventListener(eventType, onInput, { capture: true, passive: true });
              resolveReady({
                top: scroller.scrollTop,
                max: scroller.scrollHeight - scroller.clientHeight,
              });
            };
            const onInput = (event: Event) => {
              // Sample the real input before the scroller's takeover handler cancels motion.
              resolveArrival({
                top: scroller.scrollTop,
                max: scroller.scrollHeight - scroller.clientHeight,
                trusted: event.isTrusted,
                scroller:
                  event.target === scroller ||
                  (isWheel && event.target instanceof Node && scroller.contains(event.target)),
                pending: pendingAboveReader(),
              });
              clearTimeout(timer);
              document.removeEventListener(eventType, onInput, true);
            };
            const dispose = () => {
              clearTimeout(timer);
              scroller.removeEventListener("scroll", onScroll);
              document.removeEventListener(eventType, onInput, true);
              rejectReady(new Error("Native input observation ended before scrolling"));
              rejectArrival(new Error("Native input observation ended before input arrived"));
            };
            const timer = setTimeout(dispose, waitTimeout);
            scroller.addEventListener("scroll", onScroll);
            return { ready, arrived, dispose };
          },
          { waitTimeout: controlUiE2eWaitTimeoutMs, wheel },
        );
        try {
          // Arm before START; its post-click bookkeeping must not delay native input.
          const interrupt = input
            .evaluate((observation) => observation.ready)
            .then(async (position) => {
              if (wheel) {
                await page.mouse.move(track!.x + track!.width / 2, track!.y + track!.height / 2);
                await page.mouse.wheel(0, -100_000);
              } else {
                await page.mouse.click(track!.x + track!.width - 3, track!.y + 20);
              }
              return position;
            });
          const [arrival, started] = await Promise.all([
            input.evaluate((observation) => observation.arrived),
            interrupt,
            page.locator(".chat-scroll-to-bottom").click(),
          ]);
          expect(arrival).toMatchObject({ trusted: true, scroller: true });
          await saveJson(artifactDir, "native-input", { started, arrival });
          // Passive wheel handlers may follow compositor scrolling; use the pre-input sample.
          during = wheel ? started : arrival;
          expect(during.top).toBeGreaterThan(0);
          if (!wheel) {
            expect(arrival.pending).not.toBeNull();
            expect(arrival.pending!.bottom).toBeLessThanOrEqual(arrival.pending!.viewportTop);
          }
        } finally {
          await input.evaluate((observation) => observation.dispose());
          await input.dispose();
        }
      }
      if (reducedMotion === "no-preference") {
        expect(during.top).toBeLessThan(during.max);
      }
      await page.locator(".chat-scroll-to-bottom").waitFor({ state: "visible" });
      // Settle Chromium's final canceled-animation offset before releasing text.
      await waitForChatScrollIdle(page);
      if (interruption === "wheel" && reducedMotion === "reduce") {
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
      }
      const interruptedOffset = await thread.evaluate((element) => element.scrollTop);
      expect(interruptedOffset).toBeLessThan(during.max);
      if (interruption !== "wheel") {
        expect(interruptedOffset).toBeGreaterThan(0);
      }
      const interruptedAnchor = await captureTopVisibleVirtualRow(thread);
      // Native input may outlast the first row: recover a row from the settled viewport.
      const messageId = await thread.evaluate((element, position) => {
        const viewport = element.getBoundingClientRect();
        const bubbles = Array.from(
          element.querySelectorAll<HTMLElement>('.chat-bubble[data-entry-id^="sizing-message-"]'),
        );
        const bubble = bubbles.findLast((candidate) => {
          if (Number(candidate.dataset.entryId!.slice("sizing-message-".length)) % 2 !== 1) {
            return false;
          }
          const row = candidate.closest(".chat-virtual-row")!.getBoundingClientRect();
          return position === "above-viewport"
            ? row.bottom <= viewport.top
            : row.top >= viewport.top && row.top < viewport.bottom;
        });
        return bubble?.dataset.entryId ?? null;
      }, recoveryPosition);
      expect(messageId).not.toBeNull();
      const recoveredIndex = Number(messageId!.slice("sizing-message-".length));
      const nextMessageId = `sizing-message-${recoveredIndex + 1}`;
      const bubble = page.locator(`.chat-bubble[data-entry-id="${messageId}"]`);
      const requestMatcher = expect.objectContaining({
        params: expect.objectContaining({ messageId }),
      });
      const pendingRequest = (await gateway.getRequests("chat.message.get")).findLast((request) =>
        requestMatcher.asymmetricMatch(request),
      );
      expect(pendingRequest).toBeDefined();
      const initial = await bubble.evaluate(measureRow);
      expect(
        initial.bottom <= initial.viewportTop,
        `recovered row must remain mounted ${recoveryPosition}`,
      ).toBe(recoveryPosition === "above-viewport");
      if (recoveryPosition === "within-viewport") {
        expect(initial.top).toBeLessThan(initial.viewportBottom);
      }
      const fullText = rows(
        5,
        (n) =>
          `Recovered paragraph ${n}. ${"All wrapped lines must reserve space before the next user message. ".repeat(5)}`,
      ).join("\n\n");
      await gateway.deliverLatest({
        type: "res",
        id: pendingRequest!.id,
        ok: true,
        payload: { ok: true, message: { role: "assistant", content: fullText } },
      });
      await bubble.getByText("Recovered paragraph 1.", { exact: false }).waitFor();
      await waitForChatScrollIdle(page);
      // Outlast virtual-core's five-second reconciliation deadline to prove durable geometry.
      await page.clock.runFor(5_500);
      const final = await bubble.evaluate(measureRow, nextMessageId);
      const finalAnchor = await captureTopVisibleVirtualRow(thread);
      await page.screenshot({ path: path.join(artifactDir, "02-after-interruption.png") });
      await saveJson(artifactDir, "interrupted-scroll", {
        initial,
        during,
        interruptedOffset,
        interruptedAnchor,
        final,
        finalAnchor,
      });
      // Growth above the reader may adjust scrollTop, but must preserve the visible anchor.
      expect(finalAnchor.key).toBe(interruptedAnchor.key);
      expect(Math.abs(finalAnchor.viewportTop - interruptedAnchor.viewportTop)).toBeLessThanOrEqual(
        1,
      );
      if (recoveryPosition === "within-viewport") {
        expect(
          Math.abs((await thread.evaluate((element) => element.scrollTop)) - interruptedOffset),
        ).toBeLessThanOrEqual(1);
      }
      expect(final.key).toBe(initial.key);
      expect(final.height).toBeGreaterThan(initial.height);
      expect(Math.abs(final.gap), JSON.stringify({ initial, during, final })).toBeLessThanOrEqual(
        1,
      );
      // Leaving and returning proves the virtual cache, not just DOM flow, has the recovered size.
      if (recoveredIndex < 30) {
        await page.locator(".chat-scroll-to-bottom").click();
        await expect
          .poll(() =>
            thread.evaluate((element) =>
              Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
            ),
          )
          .toBeLessThanOrEqual(2);
        await page
          .locator('.chat-bubble[data-entry-id="sizing-message-59"]')
          .waitFor({ state: "visible" });
      } else {
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
      }
      await expect.poll(() => bubble.count()).toBe(0);
      // Returning is reader input: retire any still-reconciling latest command.
      await thread.hover();
      const returnDelta = await thread.evaluate(
        (element, offset) => offset - element.scrollTop,
        final.returnOffset,
      );
      await page.mouse.wheel(0, returnDelta);
      await bubble
        .getByText("Recovered paragraph 1.", { exact: false })
        .waitFor({ state: "visible" });
      await waitForChatScrollIdle(page);
      const returned = await bubble.evaluate(measureRow, nextMessageId);
      expect(returned.height).toBe(final.height);
      expect(Math.abs(returned.gap)).toBeLessThanOrEqual(1);
    },
  );
}

suite.define(() => {
  it.each([
    ["no-preference", "wheel", "within-viewport"],
    ["reduce", "wheel", "within-viewport"],
    ["no-preference", "synthetic-pointer", "within-viewport"],
    ["no-preference", "native-pointer", "above-viewport"],
  ] as const)(
    "remeasures recovered assistant text after interrupted scrolling (%s, %s, %s)",
    checkRecovery,
  );
  it("keeps completed-work and tool disclosures anchored on every expand and collapse frame", async () => {
    const { context, page } = await createDisclosurePage(800, 1400);
    const sessionKey = "agent:main:dashboard:disclosure-geometry";
    await installMockGateway(page, {
      sessionKey,
      featureMethods: ["board.get", "chat.history", "chat.metadata", "chat.startup"],
      methodResponses: {
        "board.get": {
          sessionKey,
          revision: 1,
          tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
          widgets: [],
        },
      },
      historyMessages: [
        ...makeTranscript(12),
        message("user", "Inspect the transcript and run its tests.", 99),
        assistant(
          [
            toolCall("call-anchor", "bash", { command: "pnpm test chat" }),
            toolCall("call-anchor-read", "read", { path: "chat-tool-cards.ts" }),
          ],
          100,
        ),
        toolResult("call-anchor", "bash", rows(24, (n) => `Test ${n}: passed.`).join("\n"), 101),
        toolResult("call-anchor-read", "read", "export function renderToolCard() {}", 102),
        assistant("Transcript tests pass.", 103),
        ...makeTranscript(3, 104),
        message("user", "Run one short sibling tool check.", 110),
        assistant([toolCall("call-sibling", "bash", { command: "pnpm test card" })], 111),
        toolResult("call-sibling", "bash", "Focused sibling passed.", 112),
        assistant("The sibling tool check passed.", 113),
      ],
    });

    await showSplitDashboard(page, sessionKey);
    const workSummaries = page.locator(".chat-work-group > .chat-activity-group__summary");
    const endWorkSummary = workSummaries.last();
    await endWorkSummary.waitFor({ state: "visible" });
    const endRowKey = await endWorkSummary.evaluate(
      (button) => button.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey,
    );
    expect(endRowKey).toBeTypeOf("string");
    await waitForChatScrollIdle(page);
    expect(Math.abs(await chatThreadDistanceFromBottom(page))).toBeLessThanOrEqual(2);
    const traces: Record<string, DisclosureFrame[]> = {};
    traces.workEndExpand = await traceDisclosure(endWorkSummary);
    traces.workEndCollapse = await traceDisclosure(endWorkSummary);

    const transcript = page.locator(".chat-pane-cache__pane--active .chat-thread");
    await transcript.hover();
    await page.mouse.wheel(0, -(await transcript.evaluate((element) => element.clientHeight)));
    await waitForChatScrollIdle(page);
    const middleWorkSummary = workSummaries.first();
    expect(
      await middleWorkSummary.evaluate(
        (button) => button.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey,
      ),
    ).not.toBe(endRowKey);
    await centerDisclosure(middleWorkSummary);
    traces.workMiddleExpand = await traceDisclosure(middleWorkSummary);
    const activitySummary = page
      .locator(
        ".chat-group--activity > .chat-group-messages > .chat-activity-group > .chat-activity-group__summary",
      )
      .first();
    traces.activityMiddleExpand = await traceDisclosure(activitySummary);
    const activityGroup = activitySummary.locator("..");
    const toolSummary = activityGroup
      .locator(".chat-tool-msg-summary")
      .filter({ hasText: "pnpm test chat" });
    traces.toolMiddleExpand = await traceDisclosure(toolSummary);
    traces.toolMiddleCollapse = await traceDisclosure(toolSummary);
    const fileToolToggle = activityGroup.locator(".chat-tool-row__toggle").first();
    traces.fileToolMiddleExpand = await traceDisclosure(fileToolToggle);
    traces.fileToolMiddleCollapse = await traceDisclosure(fileToolToggle);
    traces.activityMiddleCollapse = await traceDisclosure(activitySummary);
    traces.workMiddleCollapse = await traceDisclosure(middleWorkSummary);

    await context.close();
    for (const frames of Object.values(traces)) {
      expectStableFrames(frames);
    }
  });

  it("keeps raw tool details anchored at the end and middle of a long transcript", async () => {
    const { context, page } = await createDisclosurePage(600, 900);
    await installMockGateway(page, {
      historyMessages: [
        ...makeTranscript(14),
        assistant(
          [
            toolCall("raw-details-widget", "canvas_render", { title: "Geometry proof" }),
            {
              type: "tool_result",
              id: "raw-details-widget",
              name: "canvas_render",
              text: prettyJson({
                kind: "canvas",
                proof: rows(24, (n) => `Test ${n}: passed.`),
                view: {
                  backend: "canvas",
                  id: "proof",
                  url: "/__openclaw__/canvas/documents/proof/index.html",
                  title: "Geometry proof",
                  preferred_height: 160,
                },
                presentation: { target: "assistant_message" },
              }),
            },
          ],
          100,
        ),
        assistant("Disclosure geometry proof rendered.", 101),
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const toolSummary = page.locator(".chat-tool-msg-summary");
    await toolSummary.waitFor();
    await waitForChatScrollIdle(page);
    expectStableFrames(await traceDisclosure(toolSummary));
    const rawDetailsToggle = page.locator(
      ".chat-tool-card__widget-host .chat-tool-card__raw-toggle",
    );
    await rawDetailsToggle.waitFor({ state: "attached" });
    await page.locator(".chat-thread").evaluate((thread) => {
      thread.scrollTop = thread.scrollHeight;
    });
    await waitForChatScrollIdle(page);
    expect(Math.abs(await chatThreadDistanceFromBottom(page))).toBeLessThanOrEqual(2);
    const traces: Record<string, DisclosureFrame[]> = {};
    // Click the toggle directly to exclude popup close/reposition geometry from this proof.
    traces.rawDetailsEndExpand = await traceDisclosure(rawDetailsToggle);
    traces.rawDetailsEndCollapse = await traceDisclosure(rawDetailsToggle);

    await centerDisclosure(rawDetailsToggle);
    traces.rawDetailsMiddleExpand = await traceDisclosure(rawDetailsToggle);

    traces.rawDetailsMiddleCollapse = await traceDisclosure(rawDetailsToggle);
    await context.close();
    for (const [label, frames] of Object.entries(traces)) {
      expectStableFrames(frames, label);
    }
  });

  it("keeps message disclosures and shared JSON controls anchored in a long transcript", async () => {
    const { context, page } = await createDisclosurePage(600, 900);
    await installMockGateway(page, {
      historyMessages: [
        ...makeTranscript(12),
        message(
          "user",
          `User disclosure anchor marker. ${"A wrapped prompt line that must remain visually anchored. ".repeat(24)}`,
          100,
        ),
        message(
          "assistant",
          JSON.stringify({
            marker: "json-disclosure-anchor-marker",
            rows: rows(30, (n) => `JSON disclosure proof row ${n}`),
          }),
          101,
        ),
        message(
          "assistant",
          `\`\`\`text\n${"A wide transcript code line that must wrap without moving its virtual row. ".repeat(24)}\n\`\`\``,
          102,
        ),
        message("user", "Keep both sibling disclosures above this final exchange.", 103),
        assistant("Both sibling disclosures are ready.", 104),
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await waitForChatScrollIdle(page);
    const userToggle = page
      .locator(".chat-message-disclosure")
      .filter({ hasText: "User disclosure anchor marker" })
      .locator(".chat-message-disclosure__toggle");
    const jsonBlock = page
      .locator(".code-block-wrapper--json")
      .filter({ hasText: "json-disclosure-anchor-marker" });
    const jsonRoot = jsonBlock.locator(".code-block-json-tree > details");
    const jsonSummary = jsonRoot.locator(":scope > summary");
    const jsonRows = jsonRoot.locator(
      ":scope > .code-block-json-children > .code-block-json-row > details",
    );
    const rowsSummary = jsonRows.locator(":scope > summary");
    await userToggle.waitFor();
    await jsonSummary.waitFor({ state: "attached" });
    expect(await jsonRoot.getAttribute("open")).not.toBeNull();
    expect(await jsonRows.getAttribute("open")).not.toBeNull();
    const wrapToggle = page
      .locator(".code-block-wrapper")
      .filter({ hasText: "A wide transcript code line that must wrap" })
      .locator(".code-block-wrap");
    await wrapToggle.waitFor({ state: "visible" });
    const traces: Record<string, DisclosureFrame[]> = {};
    const traceVisibleControl = async (control: Locator, actionSelector?: string) => {
      // Reveal nearest edge: centering a tall footer would put its collapsed row above the reader.
      await control.evaluate((element) =>
        element.scrollIntoView({ block: "nearest", inline: "nearest" }),
      );
      await waitForChatScrollIdle(page);
      return traceDisclosure(control, actionSelector);
    };
    traces.userMessageExpand = await traceVisibleControl(userToggle);
    traces.userMessageCollapse = await traceVisibleControl(userToggle);
    traces.jsonCollapse = await traceVisibleControl(jsonSummary);
    traces.jsonExpand = await traceVisibleControl(jsonSummary);
    traces.jsonRowsCollapse = await traceVisibleControl(rowsSummary);
    traces.jsonRowsExpand = await traceVisibleControl(rowsSummary);
    const rawMode = jsonBlock.locator('[data-json-mode="raw"]');
    traces.jsonRaw = await traceVisibleControl(rawMode);
    traces.jsonTree = await traceVisibleControl(
      rawMode,
      '.code-block-json-mode[data-json-mode="tree"]',
    );
    traces.codeWrap = await traceVisibleControl(wrapToggle);
    traces.codeUnwrap = await traceVisibleControl(wrapToggle);
    await context.close();
    for (const [label, frames] of Object.entries(traces)) {
      expectStableFrames(frames, label);
    }
  });
});
