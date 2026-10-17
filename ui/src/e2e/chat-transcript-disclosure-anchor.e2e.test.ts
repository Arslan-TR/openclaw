// Control UI E2E tests protect transcript disclosure geometry across animation frames.
import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
const message = (role: string, content: unknown, timestamp: number) => ({
  role,
  content,
  timestamp,
});
const assistant = (text: string, timestamp: number) =>
  message("assistant", [textBlock(text)], timestamp);
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const toolResult = (toolCallId: string, toolName: string, text: string, timestamp: number) => ({
  ...message("toolResult", [textBlock(text)], timestamp),
  toolCallId,
  toolName,
});

function makeTranscript(
  count: number,
  prompt: (n: number) => string,
  response: (n: number) => string,
  start = 1,
) {
  return Array.from({ length: count }, (_, index) => [
    message("user", prompt(index + 1), start + index * 2),
    assistant(response(index + 1), start + index * 2 + 1),
  ]).flat();
}

async function createDisclosurePage(height: number, width: number, record = true) {
  const parent = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  const artifactDir =
    record && parent
      ? createControlUiE2eArtifactDir("chat-transcript-disclosure-anchor", parent)
      : undefined;
  const viewport = { height, width };
  const context = await suite.browser.newContext({
    reducedMotion: "reduce",
    viewport,
    ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
  });
  return { context, page: await context.newPage(), artifactDir };
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

async function saveTraces(
  directory: string | undefined,
  name: string,
  traces: Record<string, DisclosureFrame[]>,
  summary: Locator,
  focus = false,
) {
  if (!directory) {
    return;
  }
  await fs.writeFile(path.join(directory, `${name}.json`), `${JSON.stringify(traces, null, 2)}\n`);
  if (focus) {
    await summary.focus();
  }
  await captureDisclosureThemes(directory, name, summary);
}

async function captureDisclosureThemes(directory: string, name: string, summary: Locator) {
  const page = summary.page();
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") {
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
        .toBe("dark");
    }
    await fs.writeFile(
      path.join(directory, `${name}-${theme}.png`),
      await takeControlUiElementScreenshot(page, page.locator(".chat-main"), [summary]),
    );
  }
}

type DisclosureFrame = {
  expanded: boolean;
  mountedBodies: number;
  rowHeight: number;
  rowTop: number;
  scrollHeight: number;
  scrollTop: number;
};

async function toggleDisclosureWithFrameTrace(
  page: Page,
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
        mountedBodies: row.querySelectorAll(".chat-tool-msg-body, .chat-activity-group__body")
          .length,
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

function expectStableDisclosureFrames(frames: DisclosureFrame[], label = "disclosure") {
  const initial = frames[0];
  expect(initial).toBeDefined();
  expect(frames.at(-1)?.expanded, `${label} state`).toBe(!initial!.expanded);
  expect(
    frames.some(
      (frame) =>
        Math.abs(frame.rowHeight - initial!.rowHeight) > 0.5 ||
        frame.scrollHeight !== initial!.scrollHeight,
    ),
    `${label} resize`,
  ).toBe(true);
  expect(
    Math.max(...frames.map((frame) => Math.abs(frame.rowTop - initial!.rowTop))),
    `${label} geometry: ${JSON.stringify(frames)}`,
  ).toBeLessThanOrEqual(2);
  expect(
    Math.max(...frames.map((frame) => Math.abs(frame.scrollTop - initial!.scrollTop))),
    `${label} scroll offset`,
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

suite.define(() => {
  it.each([
    { reducedMotion: "no-preference", interruption: "wheel", recoveryPosition: "within-viewport" },
    { reducedMotion: "reduce", interruption: "wheel", recoveryPosition: "within-viewport" },
    {
      reducedMotion: "no-preference",
      interruption: "synthetic-pointer",
      recoveryPosition: "within-viewport",
    },
    {
      reducedMotion: "no-preference",
      interruption: "native-pointer",
      recoveryPosition: "above-viewport",
    },
  ] as const)(
    "remeasures recovered assistant text after interrupted scrolling ($reducedMotion, $interruption, $recoveryPosition)",
    async ({ reducedMotion, interruption, recoveryPosition }) => {
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
          recordVideo: { dir: artifactDir },
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
          await page.screenshot({ path: path.join(artifactDir, "01-before-scroll.png") });
          let during: { top: number; max: number };
          if (interruption === "synthetic-pointer") {
            // Check native gutter hit testing separately from animation timing.
            const pointer = await thread.evaluateHandle((element) => {
              const observed = { trusted: false, scroller: false };
              document.addEventListener(
                "pointerdown",
                (event) => {
                  observed.trusted = event.isTrusted;
                  observed.scroller = event.target === element;
                },
                { capture: true, once: true },
              );
              return observed;
            });
            const track = await thread.boundingBox();
            expect(track).not.toBeNull();
            await page.mouse.click(track!.x + track!.width - 3, track!.y + 20);
            expect(await pointer.jsonValue()).toEqual({ trusted: true, scroller: true });
            await pointer.dispose();
            // Synthetic intent runs in the first positive native scroll callback;
            // a Node round trip can outlive the fixed row's visible range.
            // Smooth animation and production cancellation remain real.
            during = await page
              .locator(".chat-scroll-to-bottom")
              .evaluate((button, waitTimeout) => {
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
                      Number(candidate.dataset.entryId!.slice("sizing-message-".length)) % 2 ===
                        1 &&
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
                    await page.mouse.move(
                      track!.x + track!.width / 2,
                      track!.y + track!.height / 2,
                    );
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
              await fs.writeFile(
                path.join(artifactDir, "native-input.json"),
                JSON.stringify({ started, arrival }, null, 2),
              );
              // A passive wheel listener can run after the compositor scrolls.
              // Prove motion started from its pre-input native scroll sample.
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
          // Chromium can commit its last canceled animation offset after input
          // returns. Capture the settled reader before releasing text.
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
          // Native input can arrive after the first message has scrolled away.
          // Select the recovery row from the settled viewport, not its fixture index.
          const messageId = await thread.evaluate((element, position) => {
            const viewport = element.getBoundingClientRect();
            const bubbles = Array.from(
              element.querySelectorAll<HTMLElement>(
                '.chat-bubble[data-entry-id^="sizing-message-"]',
              ),
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
          const pendingRequest = (await gateway.getRequests("chat.message.get")).findLast(
            (request) => requestMatcher.asymmetricMatch(request),
          );
          expect(pendingRequest).toBeDefined();
          const initial = await bubble.evaluate((element) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const rect = row.getBoundingClientRect();
            const viewport = row.closest(".chat-thread")!.getBoundingClientRect();
            return {
              key: row.dataset.virtualRowKey,
              height: row.offsetHeight,
              top: rect.top,
              bottom: rect.bottom,
              viewportTop: viewport.top,
              viewportBottom: viewport.bottom,
            };
          });
          expect(
            initial.bottom <= initial.viewportTop,
            `recovered row must remain mounted ${recoveryPosition}`,
          ).toBe(recoveryPosition === "above-viewport");
          if (recoveryPosition === "within-viewport") {
            expect(initial.top).toBeLessThan(initial.viewportBottom);
          }
          const fullText = Array.from(
            { length: 5 },
            (_, index) =>
              `Recovered paragraph ${index + 1}. ${"All wrapped lines must reserve space before the next user message. ".repeat(5)}`,
          ).join("\n\n");
          await gateway.deliverLatest({
            type: "res",
            id: pendingRequest!.id,
            ok: true,
            payload: { ok: true, message: { role: "assistant", content: fullText } },
          });
          await bubble.getByText("Recovered paragraph 1.", { exact: false }).waitFor();
          await waitForChatScrollIdle(page);
          // Outlast virtual-core's five-second scroll reconciliation deadline:
          // the assertion protects durable geometry, not a transient resize frame.
          await page.clock.runFor(5_500);
          const final = await bubble.evaluate((element, nextId) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const scroller = row.closest<HTMLElement>(".chat-thread")!;
            const next = scroller
              .querySelector(`.chat-bubble[data-entry-id="${nextId}"]`)!
              .closest<HTMLElement>(".chat-virtual-row")!;
            const rect = row.getBoundingClientRect();
            return {
              key: row.dataset.virtualRowKey,
              height: row.offsetHeight,
              top: rect.top,
              bottom: rect.bottom,
              nextTop: next.getBoundingClientRect().top,
              gap: next.getBoundingClientRect().top - rect.bottom,
              returnOffset: scroller.scrollTop + rect.top - scroller.getBoundingClientRect().top,
            };
          }, nextMessageId);
          const finalAnchor = await captureTopVisibleVirtualRow(thread);
          await page.screenshot({ path: path.join(artifactDir, "02-after-interruption.png") });
          await fs.writeFile(
            path.join(artifactDir, "interrupted-scroll.json"),
            JSON.stringify(
              { initial, during, interruptedOffset, interruptedAnchor, final, finalAnchor },
              null,
              2,
            ),
          );
          // Growth above the reader legitimately adjusts scrollTop; the visible
          // row must stay anchored regardless of where input stopped scrolling.
          expect(finalAnchor.key).toBe(interruptedAnchor.key);
          expect(
            Math.abs(finalAnchor.viewportTop - interruptedAnchor.viewportTop),
          ).toBeLessThanOrEqual(1);
          if (recoveryPosition === "within-viewport") {
            expect(
              Math.abs((await thread.evaluate((element) => element.scrollTop)) - interruptedOffset),
            ).toBeLessThanOrEqual(1);
          }
          expect(final.key).toBe(initial.key);
          expect(final.height).toBeGreaterThan(initial.height);
          expect(
            Math.abs(final.gap),
            JSON.stringify({ initial, during, final }),
          ).toBeLessThanOrEqual(1);
          // Leaving and returning must use the recovered size in the virtual
          // range too, not merely conceal stale cached geometry with DOM flow.
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
          const returned = await bubble.evaluate((element, nextId) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const next = row
              .closest(".chat-thread")!
              .querySelector(`.chat-bubble[data-entry-id="${nextId}"]`)!
              .closest<HTMLElement>(".chat-virtual-row")!;
            return {
              height: row.offsetHeight,
              gap: next.getBoundingClientRect().top - row.getBoundingClientRect().bottom,
            };
          }, nextMessageId);
          expect(returned.height).toBe(final.height);
          expect(Math.abs(returned.gap)).toBeLessThanOrEqual(1);
          await page.screenshot({ path: path.join(artifactDir, "03-after-return.png") });
          await thread.evaluate(
            (element, offset) => {
              element.scrollTop = offset;
            },
            final.returnOffset + Math.min(300, final.height / 2),
          );
          await waitForChatScrollIdle(page);
          await page.screenshot({ path: path.join(artifactDir, "04-visible-adjacency.png") });
        },
      );
    },
  );

  it("keeps completed-work and tool disclosures anchored on every expand and collapse frame", async () => {
    const { context, page, artifactDir } = await createDisclosurePage(800, 1400);
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
        ...makeTranscript(
          12,
          (n) =>
            `Earlier prompt ${n}: keep enough transcript above the active row to make the pane scroll.`,
          (n) => `Earlier response ${n}.`,
        ),
        message("user", "Inspect the transcript implementation and run its focused tests.", 99),
        message(
          "assistant",
          [
            toolCall("call-anchor", "bash", { command: "pnpm test ui/src/pages/chat" }),
            toolCall("call-anchor-read", "read", {
              path: "ui/src/pages/chat/components/chat-tool-cards.ts",
            }),
          ],
          100,
        ),
        toolResult(
          "call-anchor",
          "bash",
          Array.from(
            { length: 24 },
            (_, index) => `Focused test ${index + 1}: passed with stable transcript geometry.`,
          ).join("\n"),
          101,
        ),
        toolResult("call-anchor-read", "read", "export function renderToolCard() {}", 102),
        assistant("The transcript implementation is sound and all focused tests pass.", 103),
        ...makeTranscript(
          3,
          (n) => `Follow-up ${n}: record the next transcript observation.`,
          (n) => `Observation ${n} recorded.`,
          104,
        ),
        message("user", "Run one short sibling tool check.", 110),
        message(
          "assistant",
          [
            toolCall("call-sibling", "bash", {
              command: "pnpm test ui/src/pages/chat/components/chat-tool-cards.test.ts",
            }),
          ],
          111,
        ),
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
    traces.workEndExpand = await toggleDisclosureWithFrameTrace(page, endWorkSummary);
    traces.workEndCollapse = await toggleDisclosureWithFrameTrace(page, endWorkSummary);

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
    traces.workMiddleExpand = await toggleDisclosureWithFrameTrace(page, middleWorkSummary);
    const activitySummary = page
      .locator(
        ".chat-group--activity > .chat-group-messages > .chat-activity-group > .chat-activity-group__summary",
      )
      .first();
    traces.activityMiddleExpand = await toggleDisclosureWithFrameTrace(page, activitySummary);
    const activityGroup = activitySummary.locator("..");
    const toolSummary = activityGroup
      .locator(".chat-tool-msg-summary")
      .filter({ hasText: "pnpm test ui/src/pages/chat" });
    traces.toolMiddleExpand = await toggleDisclosureWithFrameTrace(page, toolSummary);
    traces.toolMiddleCollapse = await toggleDisclosureWithFrameTrace(page, toolSummary);
    const fileToolToggle = activityGroup.locator(".chat-tool-row__toggle").first();
    traces.fileToolMiddleExpand = await toggleDisclosureWithFrameTrace(page, fileToolToggle);
    traces.fileToolMiddleCollapse = await toggleDisclosureWithFrameTrace(page, fileToolToggle);
    traces.activityMiddleCollapse = await toggleDisclosureWithFrameTrace(page, activitySummary);
    traces.workMiddleCollapse = await toggleDisclosureWithFrameTrace(page, middleWorkSummary);

    await saveTraces(artifactDir, "disclosure-geometry", traces, middleWorkSummary, true);
    await context.close();
    for (const frames of Object.values(traces)) {
      expectStableDisclosureFrames(frames);
    }
  });

  it("keeps raw tool details anchored at the end and middle of a long transcript", async () => {
    const { context, page, artifactDir } = await createDisclosurePage(600, 900);
    await installMockGateway(page, {
      historyMessages: [
        ...makeTranscript(
          14,
          (n) => `Earlier raw-details prompt ${n}.`,
          (n) => `Earlier raw-details response ${n}.`,
        ),
        message(
          "assistant",
          [
            toolCall("raw-details-widget", "canvas_render", { title: "Disclosure geometry proof" }),
            {
              type: "tool_result",
              id: "raw-details-widget",
              name: "canvas_render",
              text: JSON.stringify(
                {
                  kind: "canvas",
                  proof: Array.from(
                    { length: 24 },
                    (_, index) => `Focused test ${index + 1}: passed with stable geometry.`,
                  ),
                  view: {
                    backend: "canvas",
                    id: "disclosure-geometry-proof",
                    url: "/__openclaw__/canvas/documents/disclosure-geometry-proof/index.html",
                    title: "Disclosure geometry proof",
                    preferred_height: 160,
                  },
                  presentation: { target: "assistant_message" },
                },
                null,
                2,
              ),
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
    expectStableDisclosureFrames(await toggleDisclosureWithFrameTrace(page, toolSummary));
    const widgetHost = page.locator(".chat-tool-card__widget-host");
    const rawDetailsToggle = widgetHost.locator(".chat-tool-card__raw-toggle");
    await rawDetailsToggle.waitFor({ state: "attached" });
    await page.locator(".chat-thread").evaluate((thread) => {
      thread.scrollTop = thread.scrollHeight;
    });
    await waitForChatScrollIdle(page);
    expect(Math.abs(await chatThreadDistanceFromBottom(page))).toBeLessThanOrEqual(2);
    const traces: Record<string, DisclosureFrame[]> = {};
    // Menu selection already proves it clicks this toggle; exclude the popup's
    // own close/reposition geometry from the transcript-anchor measurement.
    traces.rawDetailsEndExpand = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);
    traces.rawDetailsEndCollapse = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);

    await centerDisclosure(rawDetailsToggle);
    traces.rawDetailsMiddleExpand = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);

    await saveTraces(artifactDir, "raw-details-geometry", traces, toolSummary);
    traces.rawDetailsMiddleCollapse = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);
    const video = page.video();
    await context.close();
    if (artifactDir) {
      await video?.saveAs(path.join(artifactDir, "raw-details-geometry.webm"));
    }
    for (const [label, frames] of Object.entries(traces)) {
      expectStableDisclosureFrames(frames, label);
    }
  });

  it("keeps message disclosures and shared JSON controls anchored in a long transcript", async () => {
    const { context, page } = await createDisclosurePage(600, 900, false);
    await installMockGateway(page, {
      historyMessages: [
        ...makeTranscript(
          12,
          (n) => `Earlier sibling-disclosure prompt ${n}.`,
          (n) => `Earlier sibling-disclosure response ${n}.`,
        ),
        message(
          "user",
          `User disclosure anchor marker. ${"A wrapped prompt line that must remain visually anchored. ".repeat(24)}`,
          100,
        ),
        message(
          "assistant",
          JSON.stringify({
            marker: "json-disclosure-anchor-marker",
            rows: Array.from(
              { length: 30 },
              (_, index) => `JSON disclosure proof row ${index + 1}`,
            ),
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
      // JSON now opens as a tree, so earlier controls can start outside the viewport.
      // Reveal only as far as needed: centering a tall prompt's footer would put
      // its entire collapsed row above the reader, where resize compensation is correct.
      await control.evaluate((element) =>
        element.scrollIntoView({ block: "nearest", inline: "nearest" }),
      );
      await waitForChatScrollIdle(page);
      return toggleDisclosureWithFrameTrace(page, control, actionSelector);
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
      expectStableDisclosureFrames(frames, label);
    }
  });
});
