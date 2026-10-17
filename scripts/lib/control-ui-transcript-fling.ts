// Opt-in native-input benchmark. Timed sampling belongs here, not in product E2E tests.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page } from "playwright";

function installFlingProbe() {
  const thread = [...document.querySelectorAll<HTMLElement>(".chat-thread")].find(
    (node) => node.getBoundingClientRect().height > 100,
  );
  if (!thread) throw new Error("No visible transcript");
  thread.dataset.flingTarget = "true";
  const samples: Array<{
    at: number;
    top: number;
    gap: number;
    height: number;
    first: number;
    last: number;
    skipped: number;
  }> = [];
  const loaf: Array<{ start: number; duration: number; blocking: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      loaf.push({
        start: entry.startTime,
        duration: entry.duration,
        blocking: Reflect.get(entry, "blockingDuration"),
      });
    }
  });
  observer.observe({ type: "long-animation-frame" });
  let running = true;
  let frame = 0;
  const sample = () => {
    if (!running) return;
    const viewport = thread.getBoundingClientRect();
    const sizer = thread.querySelector(".chat-virtual-sizer")!.getBoundingClientRect();
    const inner = thread.querySelector(".chat-thread-inner")!.getBoundingClientRect();
    const top = Math.max(viewport.top + thread.clientTop, sizer.top);
    const bottom = Math.min(viewport.top + thread.clientTop + thread.clientHeight, inner.bottom);
    const rows = [...thread.querySelectorAll<HTMLElement>(".chat-virtual-row")];
    let cursor = top;
    let gap = 0;
    let skipped = 0;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (!row.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) {
        if (rect.bottom > top && rect.top < bottom) skipped++;
        continue;
      }
      if (rect.bottom <= top || rect.top >= bottom) continue;
      gap += Math.max(0, Math.min(rect.top, bottom) - cursor);
      cursor = Math.max(cursor, Math.min(bottom, rect.bottom));
    }
    gap += Math.max(0, bottom - cursor);
    samples.push({
      at: performance.now(),
      top: thread.scrollTop,
      gap,
      height: Math.max(0, bottom - top),
      skipped,
      first: Number(rows[0]?.dataset.index),
      last: Number(rows.at(-1)?.dataset.index),
    });
    frame = requestAnimationFrame(() => setTimeout(sample, 0));
  };
  sample();
  thread.tabIndex = 0;
  thread.focus({ preventScroll: true });
  return {
    async verify() {
      const block = thread.querySelector<HTMLElement>(".chat-virtual-block")!;
      block.style.visibility = "hidden";
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
      );
      const hidden = samples.at(-1)!;
      block.style.visibility = "";
      if (hidden.height < 100 || hidden.gap < hidden.height - 1)
        throw new Error("Blank detector failed hidden-content negative control");
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
      );
      samples.length = 0;
      loaf.length = 0;
      return { height: hidden.height, gap: hidden.gap };
    },
    mark: () => ({ at: performance.now(), sample: samples.length, top: thread.scrollTop }),
    async settle() {
      let stable = 0;
      let last = thread.scrollTop;
      for (let i = 0; i < 180; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        stable = Math.abs(thread.scrollTop - last) <= 1 ? stable + 1 : 0;
        last = thread.scrollTop;
        if (stable >= 12) return;
      }
      throw new Error("Transcript did not settle within 180 frames");
    },
    finish() {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      return { samples, loaf };
    },
  };
}

export async function probeTranscriptFling(
  page: Page,
  cdp: CDPSession,
  artifactDir: string,
  run: number,
  traced: boolean,
) {
  // Playwright does not transport methods; retain the probe on its owning page.
  await page.evaluate(
    `{ const __name = (fn) => fn; window.__fling = (${installFlingProbe.toString()})() }`,
  );
  const thread = page.locator("[data-fling-target]");
  const negativeControl = await page.evaluate(() => Reflect.get(window, "__fling").verify());
  const lastIndex = await thread.locator(".chat-virtual-row").last().getAttribute("data-index");
  if (Number(lastIndex) < 999)
    throw new Error(`Expected 1,000 virtual rows, last index ${lastIndex}`);
  const bounds = await thread.boundingBox();
  if (!bounds) throw new Error("No transcript bounds");
  const actions: Array<{
    name: string;
    start: number;
    end: number;
    inputEnd: number;
    before: number;
    after: number;
  }> = [];
  const screenshots: Array<{ data: string; timestamp: number }> = [];
  const recordFrame = (event: {
    data: string;
    metadata: { timestamp: number };
    sessionId: number;
  }) => {
    screenshots.push({ data: event.data, timestamp: event.metadata.timestamp });
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  };
  if (traced) {
    cdp.on("Page.screencastFrame", recordFrame);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
    await cdp.send("Profiler.start");
  }
  const mark = () => page.evaluate(() => Reflect.get(window, "__fling").mark());
  const settle = () => page.evaluate(() => Reflect.get(window, "__fling").settle());
  const act = async (name: string, perform: () => Promise<unknown>) => {
    const before = await mark();
    await perform();
    const inputEnd = (await mark()).at;
    await settle();
    const after = await mark();
    if (Math.abs(after.top - before.top) < 10) throw new Error(`No native movement: ${name}`);
    actions.push({
      name,
      start: before.at,
      end: after.at,
      inputEnd,
      before: before.top,
      after: after.top,
    });
  };
  try {
    await act("Home", () => page.keyboard.press("Home"));
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    for (const delta of [240, 960, 2880]) {
      await act(`wheel-down-${delta}`, async () => {
        for (let i = 0; i < 18; i++) await page.mouse.wheel(0, delta);
      });
      await act(`wheel-up-${delta}`, async () => {
        for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -delta);
      });
    }
    await act("End", () => page.keyboard.press("End"));
    await act("PageUp", async () => {
      for (let i = 0; i < 8; i++) await page.keyboard.press("PageUp");
    });
    await act("PageDown", async () => {
      for (let i = 0; i < 8; i++) await page.keyboard.press("PageDown");
    });
    await page.keyboard.press("End");
    await settle();
    const thumbShift = await thread.evaluate((element) => {
      const max = element.scrollHeight - element.clientHeight;
      return ((max - element.scrollTop) / max) * element.clientHeight;
    });
    await act("scrollbar-drag", async () => {
      await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + bounds.height - 8 - thumbShift);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + 20, { steps: 12 });
      await page.mouse.up();
    });
    await act("jump-to-bottom", () =>
      page.getByRole("button", { name: "Scroll to latest" }).click(),
    );
    const raw = await page.evaluate(() => Reflect.get(window, "__fling").finish());
    const result = {
      initialLastRowIndex: Number(lastIndex),
      negativeControl,
      measurement:
        "Post-animation-frame DOM coverage excluding content-visibility:auto skipped rows; ordinary whitespace inside rows counts as covered. rAF gaps estimate missed main-thread frames, not compositor frames. Traced runs retain a compositor screencast for visual cross-check; they are excluded from timing comparisons.",
      actions: actions.map((action) => {
        const frames = raw.samples.filter(
          (s: { at: number }) => s.at >= action.start && s.at <= action.end,
        );
        const filled = frames.findIndex(
          (s: { top: number; gap: number }) => Math.abs(s.top - action.after) <= 1 && s.gap <= 1,
        );
        const gaps = frames.slice(1).map((s: { at: number }, i: number) => s.at - frames[i].at);
        const longFrames = raw.loaf.filter(
          (s: { start: number }) => s.start >= action.start && s.start < action.end,
        );
        return {
          ...action,
          inputPixelsPerMs:
            Math.abs(action.after - action.before) / (action.inputEnd - action.start),
          frames: frames.length,
          blankFrames: frames.filter((s: { gap: number }) => s.gap > 1).length,
          maxBlankFraction: Math.max(
            0,
            ...frames.map((s: { gap: number; height: number }) => s.gap / s.height),
          ),
          maxBlankPx: Math.max(0, ...frames.map((s: { gap: number }) => s.gap)),
          maxFrameGapMs: Math.max(0, ...gaps),
          missedFrames: gaps.reduce(
            (sum: number, ms: number) => sum + Math.max(0, Math.round(ms / (1000 / 60)) - 1),
            0,
          ),
          timeToFilledMs: filled < 0 ? null : frames[filled].at - action.start,
          loafBlockingMs: longFrames.reduce(
            (sum: number, s: { blocking: number }) => sum + s.blocking,
            0,
          ),
          loafCount: longFrames.length,
        };
      }),
      ...raw,
    };
    await writeFile(path.join(artifactDir, `run-${run + 1}.fling.json`), JSON.stringify(result));
    return result;
  } finally {
    const raw = await page.evaluate(() => Reflect.get(window, "__fling").finish());
    await writeFile(
      path.join(artifactDir, `run-${run + 1}.fling-raw.json`),
      JSON.stringify({ actions, ...raw }),
    );
    await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.fling.png`) });
    if (traced) {
      const profile = await cdp.send("Profiler.stop");
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.fling.cpuprofile`),
        JSON.stringify(profile.profile),
      );
      await cdp.send("Page.stopScreencast");
      cdp.off("Page.screencastFrame", recordFrame);
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.fling.filmstrip.json`),
        JSON.stringify(screenshots),
      );
    }
  }
}
