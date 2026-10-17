import { readFileSync } from "node:fs";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Expanded video gallery" });
// Existing synthetic VP9 fixture; no generated media is added to the source tree.
const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url));
const clip = (name: string) => `MEDIA:https://example.com/gallery-proof/${name}.mp4`;

// CDP is used only to locate Chromium's closed native controls. Input is real mouse input.
async function nativeVideoControlBox(cdp: CDPSession, control: string) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: 'document.querySelector("openclaw-image-lightbox").querySelector("video")',
  });
  if (!result.objectId) {
    throw new Error("Missing expanded native player");
  }
  const { node } = await cdp.send("DOM.describeNode", {
    objectId: result.objectId,
    depth: -1,
    pierce: true,
  });
  await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
  const pending = [node];
  let native: typeof node | undefined;
  while (pending.length) {
    const candidate = pending.pop()!;
    if (candidate.attributes?.includes("-webkit-media-controls-" + control)) {
      native = candidate;
      break;
    }
    pending.push(...[...(candidate.children ?? []), ...(candidate.shadowRoots ?? [])].toReversed());
  }
  if (!native) {
    throw new Error("Missing native control " + control);
  }
  const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: native.backendNodeId });
  const x = model.content[0]!;
  const y = model.content[1]!;
  return { x, y, width: model.content[2]! - x, height: model.content[5]! - y };
}

async function verifyGallery(page: Page, context: BrowserContext, mobile: boolean) {
  await page.route("**/gallery-proof/*.mp4", (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: "video/mp4",
      headers: {
        "accept-ranges": "bytes",
        ...(range ? { "content-range": `bytes ${start}-${end}/${video.length}` } : {}),
      },
      body: video.subarray(start, end + 1),
    });
  });
  const gateway = await installMockGateway(page, {
    historyMessages: [
      ["user", "Compare these clips."],
      ["assistant", `**Before**\n${clip("before")}\n\n**After**\n${clip("after")}`],
      ["assistant", `**Alternate**\n${clip("alternate")}`],
      ["user", "A separate turn."],
      ["assistant", clip("separate")],
    ].map(([role, content], index) => ({
      role,
      content,
      timestamp: 1800000000000 + index * 1000,
    })),
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await gateway.waitForRequest("chat.startup");
  // Lazy media admission creates the expand button only near the viewport.
  await page.getByText("before.mp4", { exact: true }).scrollIntoViewIfNeeded();
  const expand = page.getByRole("button", {
    name: "Expand before.mp4 in the media overlay",
    exact: true,
  });
  await expand.scrollIntoViewIfNeeded();
  await expand.waitFor();
  await expand.click();
  const viewer = page.locator("openclaw-image-lightbox");
  const player = viewer.locator("video");
  const counter = viewer.locator(".gallery-counter");
  const ready = () => player.evaluate((media: HTMLVideoElement) => media.readyState);
  const paused = () => player.evaluate((media: HTMLVideoElement) => media.paused);
  const time = () => player.evaluate((media: HTMLVideoElement) => media.currentTime);
  const fullscreen = () => player.evaluate((media) => media.matches(":fullscreen"));
  const position = async () => (await counter.textContent())?.trim();
  const navigate = async (key: string, name: string) => {
    await page.keyboard.press(key);
    await expect.poll(() => player.getAttribute("src")).toContain(`${name}.mp4`);
  };
  await expect.poll(ready).toBeGreaterThanOrEqual(2);
  await expect.poll(position).toBe("1 / 3");
  expect(
    await viewer.evaluate((element) => {
      const videoBox = element.querySelector("video")!.getBoundingClientRect();
      return [...element.querySelectorAll(".actions, .navigation, .gallery-counter")].every(
        (control) => {
          const box = control.getBoundingClientRect();
          return (
            box.bottom + 8 <= videoBox.top ||
            box.top >= videoBox.bottom + 8 ||
            box.right + 8 <= videoBox.left ||
            box.left >= videoBox.right + 8
          );
        },
      );
    }),
  ).toBe(true);
  await navigate("ArrowRight", "after");
  await navigate("ArrowRight", "alternate");
  await page.keyboard.press("ArrowRight");
  expect(await position()).toBe("3 / 3");
  await navigate("ArrowLeft", "after");
  await expect.poll(ready).toBeGreaterThanOrEqual(2);
  const controls = await context.newCDPSession(page);
  const clickNative = async (name: string, fraction = 0.5) => {
    await player.hover();
    const box = await nativeVideoControlBox(controls, name);
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
  };
  // Pause using the real native button, then scrub the real timeline.
  if (!(await paused())) {
    await clickNative("play-button");
  }
  await expect.poll(paused).toBe(true);
  await clickNative("timeline", 0.25);
  await expect.poll(time).toBeGreaterThan(0.1);
  expect(await position()).toBe("2 / 3");
  await player.focus();
  const beforeSeek = await time();
  await page.keyboard.press("ArrowRight");
  await expect.poll(time).toBeGreaterThan(beforeSeek);
  expect(await position()).toBe("2 / 3");
  await clickNative("timeline", 0.1);
  await clickNative("play-button");
  await expect.poll(paused).toBe(false);
  await clickNative("play-button");
  await expect.poll(paused).toBe(true);
  if (!mobile) {
    await clickNative("fullscreen-button");
    await expect.poll(fullscreen).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(fullscreen).toBe(false);
    expect(await viewer.count()).toBe(1);
  }
  const retained = await player.elementHandle();
  if (mobile) {
    const touchEvent = (
      type: "touchStart" | "touchMove" | "touchEnd",
      ...touchPoints: Array<{ x: number; y: number; id: number }>
    ) => controls.send("Input.dispatchTouchEvent", { type, touchPoints });
    const drag = async (point: { x: number; y: number; id: number }, dx: number, steps = 1) => {
      await touchEvent("touchStart", point);
      for (let step = 1; step <= steps; step++) {
        await touchEvent("touchMove", { ...point, x: point.x + (dx * step) / steps });
      }
      await touchEvent("touchEnd");
    };
    const timeline = await nativeVideoControlBox(controls, "timeline");
    const timelinePoint = {
      x: timeline.x + timeline.width * 0.2,
      y: timeline.y + timeline.height / 2,
      id: 1,
    };
    await drag(timelinePoint, timeline.width * 0.4);
    await expect.poll(time).toBeGreaterThan(0.3);
    expect(await position()).toBe("2 / 3");
    const swipe = async (dx: number) => {
      const box = await player.boundingBox();
      if (!box) {
        throw new Error("Missing video geometry");
      }
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 3, id: 1 };
      await drag(point, dx, 5);
    };
    await swipe(-100);
    await expect.poll(() => player.getAttribute("src")).toContain("alternate.mp4");
    await swipe(100);
    await expect.poll(() => player.getAttribute("src")).toContain("after.mp4");
    expect(await page.locator(".content[inert]").count()).toBe(0);
  }
  await controls.detach();
  await viewer.getByRole("button", { name: "Close video preview", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => viewer.count()).toBe(0);
  expect(
    await retained?.evaluate(
      (media: HTMLVideoElement) => media.paused && !media.hasAttribute("src"),
    ),
  ).toBe(true);
  await retained?.dispose();
  await expect.poll(() => expand.evaluate((element) => element.matches(":focus"))).toBe(true);
  await page
    .getByRole("button", { name: "Expand separate.mp4 in the media overlay", exact: true })
    .click();
  expect(await viewer.locator(".gallery-counter").count()).toBe(0);
  await page.keyboard.press("Escape");
}

suite.define(() => {
  it.each([false, true])(
    "navigates the whole turn and preserves player controls (touch=%s)",
    async (mobile) => {
      await suite.withPage(
        {
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
          hasTouch: mobile,
          isMobile: mobile,
        },
        ({ page, context }) => verifyGallery(page, context, mobile),
      );
    },
  );
});
