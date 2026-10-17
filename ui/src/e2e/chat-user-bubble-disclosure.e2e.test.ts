import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import {
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const artifactPath = (name: string) => path.join(suite.artifactDir, "user-bubble-clamp", name);
const preview = (root: Page | Locator) => root.locator(".chat-message-disclosure__content");
const height = (content: Locator) => content.evaluate((element) => element.clientHeight);
const mask = (content: Locator) =>
  content.evaluate((element) => getComputedStyle(element).maskImage);
const message = (content: unknown, timestamp = 1, role = "user") => ({ role, content, timestamp });
const browserOptions = (width = 1440, colorScheme: "light" | "dark" = "light") => ({
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { width, height: 844 },
  colorScheme,
});

async function screenshot(target: Page | Locator, name: string) {
  if (captureUiProofEnabled) {
    await target.screenshot({ path: artifactPath(name) });
  }
}

async function openChat(
  historyMessages: unknown[],
  options: Parameters<typeof suite.newBrowserContext>[0] = {
    viewport: { width: 1440, height: 844 },
  },
) {
  const page = await newChatPage(suite, options);
  await installMockGateway(page, { historyMessages });
  await page.goto(`${suite.server.baseUrl}chat`);
  return page;
}

// Runs in the browser; keep Range sampling shared, with each caller's line policy explicit.
function measureText(element: Element, mode: "preview" | "details" | "reveal") {
  const bounds = (node: Element) => {
    const { left, top, right, bottom } = node.getBoundingClientRect();
    return { left, top, right, bottom };
  };
  const paragraph = mode === "preview" ? element.querySelector("p, li")! : element;
  const style = getComputedStyle(paragraph);
  const clip = element.closest(".chat-message-disclosure__content")!;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const lines: Array<{ top: number; bottom: number; height: number }> = [];
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (
      !node.textContent?.trim() ||
      (mode === "details" && node.parentElement?.closest("summary"))
    ) {
      continue;
    }
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (
        rect.width > 0 &&
        (mode === "reveal" ? rect.height > 0 : !lines.some((line) => line.top === rect.top))
      ) {
        lines.push({ top: rect.top, bottom: rect.bottom, height: rect.height });
      }
    }
  }
  const transcript = element.closest<HTMLElement>(".chat-thread");
  if (!transcript) {
    throw new Error("Disclosure content has no transcript");
  }
  const transcriptBounds = bounds(transcript);
  const left = transcriptBounds.left + transcript.clientLeft;
  const top = transcriptBounds.top + transcript.clientTop;
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = style.font;
  return {
    lines,
    bounds: bounds(element),
    clip: bounds(clip),
    paragraph: bounds(paragraph),
    scrollTop: clip.scrollTop,
    lineHeight: Number.parseFloat(style.lineHeight),
    ascent: context.measureText("x").fontBoundingBoxAscent,
    viewport: { width: innerWidth, height: innerHeight },
    transcriptClip: {
      left,
      top,
      right: left + transcript.clientWidth,
      bottom: top + transcript.clientHeight,
    },
  };
}

async function expectCenteredToggle(bubble: Locator) {
  const { above, below } = await bubble.evaluate((element) => {
    const content = element.querySelector(".chat-message-disclosure__content")!;
    const toggle = element.querySelector(".chat-message-disclosure__toggle")!;
    const surface = element.classList.contains("chat-bubble--with-images")
      ? content.parentElement!
      : element;
    const button = toggle.getBoundingClientRect();
    return {
      above: button.top - content.getBoundingClientRect().bottom,
      below:
        surface.getBoundingClientRect().bottom -
        Number.parseFloat(getComputedStyle(surface).borderBottomWidth) -
        button.bottom,
    };
  });
  expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
}

async function expectReadableLastLine(page: Page, content: Locator) {
  const text = content.locator(".chat-text");
  await waitForControlUiProofSurface(content, [text]);
  await waitForLayoutSettled(page, ".chat-message-disclosure__content");
  const geometry = await content.evaluate(measureText, "preview");
  const { bounds, viewport, transcriptClip, lines, lineHeight } = geometry;
  const visible = lines.filter((line) => line.top < bounds.bottom);
  const last = visible.at(-1)!;
  const lineTop = last.top - (lines[0]!.top - geometry.paragraph.top);
  const baseline = last.top + geometry.ascent;
  const fraction = (bounds.bottom - lineTop) / lineHeight;
  expect(visible).toHaveLength(5);
  expect(fraction).toBeGreaterThanOrEqual(0.66);
  expect(fraction).toBeLessThanOrEqual(0.75);
  expect(bounds.bottom > baseline, "the x-height fits above the cut").toBe(true);
  expect(bounds.right).toBeGreaterThan(bounds.left);
  expect(bounds.bottom).toBeGreaterThan(bounds.top);
  expect(bounds.left).toBeGreaterThanOrEqual(Math.max(0, transcriptClip.left));
  expect(bounds.top).toBeGreaterThanOrEqual(Math.max(0, transcriptClip.top));
  expect(bounds.right).toBeLessThanOrEqual(Math.min(viewport.width, transcriptClip.right));
  expect(bounds.bottom).toBeLessThanOrEqual(Math.min(viewport.height, transcriptClip.bottom));
  const readBounds = () =>
    content.evaluate((element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    });
  const capture = async () => {
    expect(await readBounds()).toEqual(bounds);
    const png = await takeControlUiViewportScreenshot(page, content, [text]);
    expect(await readBounds()).toEqual(bounds);
    return png;
  };
  const masked = await capture();
  await content.evaluate((element) => ((element as HTMLElement).style.maskImage = "none"));
  let unmasked: Buffer;
  try {
    unmasked = await capture();
  } finally {
    await content.evaluate((element) =>
      (element as HTMLElement).style.removeProperty("mask-image"),
    );
  }
  const rows = await content.evaluate(
    async (_, { images, sampleRows, bounds: clip, viewport: size }) => {
      const sampleImage = async (source: string) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const scaleX = image.width / size.width;
        const scaleY = image.height / size.height;
        const left = Math.floor(clip.left * scaleX);
        const right = Math.ceil(clip.right * scaleX);
        const top = Math.floor(clip.top * scaleY);
        const sampleRow = (relativeY: number) => {
          // Match an enclosing element crop while scaling CSS rows to device pixels.
          const y = top + Math.floor(relativeY * scaleY);
          if (left < 0 || right > image.width || right <= left || y < 0 || y >= image.height) {
            throw new Error("Disclosure sample falls outside the captured viewport");
          }
          const { data } = context.getImageData(left, y, right - left, 1);
          const values: number[] = [];
          for (let x = 0; x < right - left; x++) {
            values.push(data.subarray(x * 4, x * 4 + 3).reduce((sum, value) => sum + value, 0));
          }
          return Math.max(...values) - Math.min(...values);
        };
        return {
          dimensions: { width: image.width, height: image.height },
          upper: sampleRow(sampleRows.upper),
          lower: sampleRow(sampleRows.lower),
        };
      };
      return Promise.all([sampleImage(images.masked), sampleImage(images.unmasked)]);
    },
    {
      images: {
        masked: `data:image/png;base64,${masked.toString("base64")}`,
        unmasked: `data:image/png;base64,${unmasked.toString("base64")}`,
      },
      sampleRows: {
        upper: Math.floor(lineTop + lineHeight / 2 - bounds.top) - 1,
        lower: Math.floor(baseline - bounds.top - 1),
      },
      bounds,
      viewport,
    },
  );
  expect(rows[0].dimensions).toEqual(rows[1].dimensions);
  const upperAlpha = rows[0].upper / rows[1].upper;
  const lowerAlpha = rows[0].lower / rows[1].lower;
  expect(upperAlpha, "the upper half remains legible").toBeGreaterThan(0.65);
  expect(upperAlpha, "the fade reaches the upper half instead of ending abruptly").toBeLessThan(
    0.9,
  );
  expect(lowerAlpha, "the bottom of the line visibly fades").toBeLessThan(upperAlpha - 0.2);
}

suite.define(() => {
  it.each([
    { theme: "light", width: 1440, withImage: false, layout: "continuous" },
    { theme: "dark", width: 390, withImage: true, layout: "paragraphs" },
    { theme: "light", width: 390, withImage: false, layout: "list" },
  ] as const)(
    "clamps and centers a long prompt in $theme at $width px (image: $withImage, layout: $layout)",
    async ({ theme, width, withImage, layout }) => {
      const prose =
        (layout === "paragraphs" ? "Opening context.\nReview the sample notes.\n\n" : "") +
        `${"This long prompt stays mounted while its preview is clamped. ".repeat(22)}Final prompt tail.`.slice(
          0,
          1_300,
        );
      const text =
        layout === "list"
          ? Array.from(
              { length: 18 },
              (_, index) =>
                `- Review sample item ${index + 1}: keep the project notes clear and explain the next useful step.`,
            ).join("\n")
          : prose;
      const page = await openChat(
        [
          message([
            ...(withImage
              ? [
                  {
                    type: "image",
                    url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='32'%3E%3Crect width='64' height='32' fill='teal'/%3E%3C/svg%3E",
                  },
                ]
              : []),
            { type: "text", text },
          ]),
          // Source exceeds the threshold, but all five rendered lines fit the full preview.
          message(
            Array.from(
              { length: 5 },
              (_, index) => `[Short link ${index + 1}](https://example.com/${"a".repeat(300)})`,
            ).join("\n"),
            2,
          ),
        ],
        browserOptions(width, theme),
      );
      const bubbles = page.locator(".chat-group.user .chat-bubble");
      const bubble = bubbles.first();
      await bubble.waitFor({ state: "visible", timeout: 10_000 });
      const content = preview(bubble);
      const toggle = bubble.getByRole("button", { name: "Show more" });

      await page.evaluate(() => document.fonts.ready);
      await expectCenteredToggle(bubble);
      await expectReadableLastLine(page, content);
      expect(await mask(content)).not.toBe("none");
      const fitting = bubbles.nth(1);
      await fitting.locator(".chat-message-disclosure__toggle").waitFor({ state: "hidden" });
      expect(await mask(preview(fitting))).toBe("none");
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      const rendered = await content
        .locator(layout === "list" ? ".chat-text li" : ".chat-text p")
        .allTextContents();
      expect(rendered).toEqual(
        layout === "list" ? text.split("\n").map((item) => item.slice(2)) : text.split("\n\n"),
      );
      const collapsedHeight = await height(content);
      expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );
      await screenshot(
        bubble,
        `${theme}-${width}-${withImage ? "image" : "text"}-${layout}-collapsed.png`,
      );

      await toggle.click();
      const collapse = bubble.getByRole("button", { name: "Show less" });
      expect(await collapse.getAttribute("aria-expanded")).toBe("true");
      await expectCenteredToggle(bubble);
      expect(await mask(content)).toBe("none");
      expect(await height(content)).toBeGreaterThan(collapsedHeight);
    },
  );

  it("remeasures the fifth line after viewport and text reflow", async () => {
    const page = await openChat(
      [
        message(
          "Keep the project notes clear enough for someone reading the conversation later. ".repeat(
            3,
          ) +
            "\n\n" +
            "The remaining sample notes stay available after expansion. ".repeat(24),
        ),
      ],
      browserOptions(),
    );
    const content = preview(page);
    await content.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expectReadableLastLine(page, content);
    const desktopHeight = await height(content);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => height(content)).not.toBe(desktopHeight);
    await expectReadableLastLine(page, content);
    await page.setViewportSize({ width: 1440, height: 844 });
    await expect.poll(() => height(content)).toBe(desktopHeight);
    await expectReadableLastLine(page, content);
    await content.locator(".chat-text").evaluate((element) => {
      (element as HTMLElement).style.fontSize = "18px";
    });
    await expect.poll(() => height(content)).not.toBe(desktopHeight);
    await expectReadableLastLine(page, content);
  });

  it.each(["paragraphs", "escaped HTML", "native summary"])(
    "measures visible lines when authored details with %s close and reopen",
    async (body) => {
      const page = await openChat([
        message(
          (body === "native summary"
            ? "<details>\n\n"
            : "<details><summary>Hidden reference</summary>\n\n") +
            (body === "escaped HTML"
              ? `<div>${"Hidden row with reference text. ".repeat(20)}</div>\n`
              : "Hidden row with reference text.\n".repeat(20)) +
            "\n</details>\n\n" +
            "Visible project notes continue here and explain the next useful step. ".repeat(28),
        ),
      ]);
      const content = preview(page);
      const details = content.locator("details");
      const summary = details.locator("summary");
      await details.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const expectFourthProseLineCut = async (paragraph: Locator) => {
        const fraction = async () => {
          const { lines, lineHeight, clip } = await paragraph.evaluate(measureText, "details");
          const fourth = lines[3]!;
          const lineTop = fourth.top - Math.floor((lineHeight - fourth.height) / 2);
          return (clip.bottom - lineTop) / lineHeight;
        };
        // The visible summary owns the first preview line; prose supplies the next four.
        await expect.poll(fraction).toSatisfy((value: number) => value >= 0.66 && value <= 0.75);
      };
      const outside = content.locator(".chat-text > p");
      const toggleDetails = () =>
        body === "native summary" ? details.click({ position: { x: 30, y: 10 } }) : summary.click();
      await expectFourthProseLineCut(outside);
      await toggleDetails();
      await expectFourthProseLineCut(details);
      await toggleDetails();
      await expectFourthProseLineCut(outside);
    },
  );

  it("keeps densely spaced block art within five preview rows", async () => {
    const page = await openChat([
      message(
        `\`\`\`\n${Array.from({ length: 24 }, () => "█▀▄ ".repeat(20)).join("\n")}\n\`\`\`\n\n${"Follow the sample notes. ".repeat(60)}`,
      ),
    ]);
    const content = preview(page);
    await content.waitFor();
    await page.evaluate(() => document.fonts.ready);
    const visibleRows = await content.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector("code.markdown-block-art")!);
      const bottom = element.getBoundingClientRect().bottom;
      return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.top < bottom)
        .length;
    });
    expect(visibleRows).toBe(5);
  });

  it.each([{ name: "mobile", width: 390, height: 844 }])(
    "keeps collapsed paragraphs readable after reload and browser reveal ($name)",
    async (viewport) => {
      const paragraphs = [
        ...Array.from(
          { length: 8 },
          (_, index) =>
            `Background paragraph ${index + 1}. Please review the synthetic project notes and summarize the next steps. Keep the explanation clear enough for someone reading the conversation later.`,
        ),
        ...["First", "Second"].map((label) =>
          [
            `${label} request:`,
            "<review_request>",
            "<input>Read the sample notes and explain the next step,",
            "then describe the expected result.</input>",
            "<context>The sample is ready for review.</context>",
            "</review_request>",
          ].join("\n"),
        ),
        "Final prompt tail: the complete request remains available.",
      ];
      const page = await openChat(
        [
          message(paragraphs.join("\n\n")),
          message("Short follow-up request.", 2),
          message("The sample review is complete.", 3, "assistant"),
        ],
        browserOptions(viewport.width),
      );
      const bubble = page.locator(".chat-group.user .chat-bubble").first();
      const toggle = bubble.getByRole("button", { name: "Show more", exact: true });
      await toggle.waitFor({ state: "visible" });
      await page.reload();
      await toggle.waitFor({ state: "visible" });
      const content = preview(bubble);
      const markdown = content.locator(".chat-text");
      const initialCollapsedHeight = await height(content);
      expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await markdown.locator("p").allTextContents()).toEqual(paragraphs);

      // Browser descendant reveal can scroll an overflow-hidden preview without expanding it.
      const revealedParagraph = markdown.locator("p").nth(9);
      await revealedParagraph.scrollIntoViewIfNeeded();
      const measured = await revealedParagraph.evaluate(measureText, "reveal");
      const verticalBounds = ({ top, bottom }: { top: number; bottom: number }) => ({
        top,
        bottom,
      });
      const geometry = {
        scrollTop: measured.scrollTop,
        clip: verticalBounds(measured.clip),
        paragraph: verticalBounds(measured.paragraph),
        lines: measured.lines.map(verticalBounds),
      };
      await screenshot(page, `${viewport.name}-revealed.png`);
      if (captureUiProofEnabled) {
        await writeFile(
          artifactPath(`${viewport.name}-geometry.json`),
          `${JSON.stringify(geometry, null, 2)}\n`,
        );
      }
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(geometry.scrollTop).toBeGreaterThan(0);
      expect(
        geometry.lines.filter(
          (line) => line.top >= geometry.clip.top && line.bottom <= geometry.clip.bottom,
        ).length,
      ).toBeGreaterThan(0);
      expect(geometry.lines.length).toBeGreaterThanOrEqual(6);
      for (const line of geometry.lines) {
        expect(line.top, "text starts within its own paragraph").toBeGreaterThanOrEqual(
          geometry.paragraph.top - 1,
        );
        expect(
          line.bottom,
          "text ends within its own paragraph without overlapping the next",
        ).toBeLessThanOrEqual(geometry.paragraph.bottom + 1);
      }
      const collapsedHeight = await height(content);
      expect(collapsedHeight).toBe(initialCollapsedHeight);

      await toggle.click();
      const collapse = bubble.getByRole("button", { name: "Show less", exact: true });
      expect(await collapse.getAttribute("aria-expanded")).toBe("true");
      expect(await height(content)).toBeGreaterThan(collapsedHeight);
      expect(
        await content.evaluate((element) => element.scrollHeight - element.clientHeight),
      ).toBeLessThanOrEqual(1);
      const tail = markdown.locator("p").last();
      await tail.scrollIntoViewIfNeeded();
      expect(await tail.textContent()).toBe(paragraphs.at(-1));
      await screenshot(page, `${viewport.name}-expanded-tail.png`);
      await collapse.click();
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await height(content)).toBe(initialCollapsedHeight);
      const siblings = page.locator(".chat-group .chat-bubble");
      expect(await siblings.nth(1).textContent()).toContain("Short follow-up request.");
      expect(await siblings.nth(2).textContent()).toContain("The sample review is complete.");
      const boxes = await siblings.evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        }),
      );
      expect(boxes).toHaveLength(3);
      for (let index = 1; index < boxes.length; index++) {
        expect(boxes[index - 1]!.bottom).toBeLessThanOrEqual(boxes[index]!.top + 1);
      }
    },
  );
});
