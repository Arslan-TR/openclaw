/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { openEditor } from "../../../lib/editor-links.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../../../test-helpers/native-gateways.ts";
import "./chat-detail-panel.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatDetailPanel as DetailPanel } from "./chat-detail-panel.tsx";
import { setFileDraft } from "./chat-file-drafts.ts";
import type { ChatHtmlPreviewElement } from "./chat-html-preview-element.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import type { FileEditorViewHandle } from "./file-editor-view.ts";

const file = (
  path = "src/example.ts",
  content = "const answer = 42;",
): Extract<SidebarContent, { kind: "file" }> => ({
  kind: "file",
  path,
  name: path.split("/").at(-1)!,
  content,
});
const query = <T extends Element = HTMLElement>(panel: Element, selector: string) =>
  panel.querySelector<T>(selector);
const downloadButton = (panel: Element) =>
  expectDefined(
    query<HTMLButtonElement>(panel, ".chat-assistant-attachment-card__download"),
    "Download button",
  );
const attachment = (
  props: Partial<Extract<SidebarContent, { kind: "attachment" }>>,
): SidebarContent => ({
  kind: "attachment",
  attachmentKind: "document",
  title: "report.zip",
  ...props,
});
async function settle(panel: DetailPanel) {
  await Promise.resolve();
  await Promise.resolve();
  await panel.updateComplete;
}
function activate(link: Element | null, action: string) {
  const options = { bubbles: true, cancelable: true };
  const event =
    action === "click"
      ? new MouseEvent("click", { ...options, button: 0 })
      : new KeyboardEvent("keydown", { ...options, key: "Enter" });
  link?.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

// mock-isolation: These sidebar contracts exclude CodeMirror's browser layout and language loading.
vi.mock("./file-editor-view.ts", () => ({
  createFileEditorView: async ({ content }: { content: string }) => {
    let text = content;
    return {
      destroy() {},
      setContent(next: string) {
        text = next;
      },
      contentEquals: (next: string) => text === next,
      getContent: () => text,
      setEditable() {},
      setLineWrapping() {},
      setDecorations() {},
      scrollToLine() {},
      onDocChanged() {},
      focus() {},
    } satisfies FileEditorViewHandle;
  },
}));

async function mountPanel(
  content: SidebarContent,
  props: Partial<DetailPanel> = {},
): Promise<DetailPanel> {
  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  Object.assign(panel, { content }, props);
  container.append(panel);
  await panel.updateComplete;
  return panel;
}

let container: HTMLElement;
beforeEach(() => {
  container = createChatSidebarContainer();
  document.body.append(container);
});
afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  ["Windows path", "vscode", "C:\\src\\a.ts", 42, "vscode://file/C:/src/a.ts:42"],
  ["URL chars", "windsurf", "/#a?.md", undefined, "windsurf://file/%23a%3F.md"],
] as const)("opens the encoded custom URL for %s", (_name, editor, path, line, expected) => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  openEditor(editor, path, line);
  expect(open).toHaveBeenCalledWith(expected);
  open.mockRestore();
});
describe("file sidebar editor locality", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    clearNativeGatewayTestState();
  });

  it("removes editor controls when the native gateway switches to remote", async () => {
    setNativeGatewayTestState("local");
    const panel = await mountPanel({ ...file(), root: "/workspace" });
    expect(panel.querySelector('[aria-label="Open in editor"]')).not.toBeNull();
    expect(panel.querySelectorAll(".sidebar-file-view__editor-item")).toHaveLength(4);
    expect(panel.querySelector(".sidebar-file-view__editor")).not.toBeNull();
    setNativeGatewayTestState("remote");
    await panel.updateComplete;
    expect(panel.querySelector('[aria-label="Open in editor"]')).toBeNull();
    expect(panel.querySelector(".sidebar-file-view__editor")).toBeNull();
  });
});

describe("markdown sidebar", () => {
  it.each([
    { kind: "markdown", trailingNewline: false },
    { kind: "file", trailingNewline: true },
  ] as const)("keeps nested code literal when viewing raw $kind text", async (testCase) => {
    const source =
      ["Intro", "", "```ts", "const x = 1;", "```", "", "**literal after**"].join("\n") +
      (testCase.trailingNewline ? "\n" : "");
    const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
    panel.content =
      testCase.kind === "markdown"
        ? { kind: "markdown", content: "Rendered summary", rawText: source }
        : { kind: "file", path: "notes.md", name: "notes.md", language: "md", content: source };
    container.append(panel);
    const schedule = vi.spyOn(globalThis, "setTimeout");
    try {
      await panel.updateComplete;
      const rawButton = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "View Raw Text",
      );
      expect(rawButton).toBeDefined();
      rawButton!.click();
      await panel.updateComplete;
      expect(panel.querySelector(".sidebar-title")?.textContent?.trim()).toBe("Source");
      expect(panel.querySelector(".sidebar-markdown-shell__eyebrow")?.textContent?.trim()).toBe(
        "Source",
      );
      expect(panel.querySelector(".sidebar-markdown-shell__hint")).toBeNull();
      expect(panel.querySelector(".sidebar-markdown-shell__toolbar button")).toBeNull();
      const reader = panel.querySelector(".sidebar-markdown-reader");
      const copyButton = reader?.querySelector<HTMLButtonElement>(".code-block-copy");
      expect(copyButton).toBeInstanceOf(HTMLButtonElement);
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      copyButton!.click();
      await vi.waitFor(() => expect(copyButton!.getAttribute("aria-label")).toBe("Copied!"));
      expect(writeText).toHaveBeenCalledOnce();
      expect.soft(reader?.querySelectorAll("pre code")).toHaveLength(1);
      expect.soft(reader?.querySelector("pre code")?.textContent).toBe(`${source}\n`);
      expect.soft(reader?.querySelector("strong")).toBeNull();
      expect.soft(writeText).toHaveBeenCalledWith(source);
      panel.content = { kind: "markdown", content: "## Fresh preview" };
      await panel.updateComplete;
      expect(panel.querySelector(".sidebar-markdown-shell__eyebrow")?.textContent?.trim()).toBe(
        "Rendered Markdown",
      );
      expect(panel.querySelector(".sidebar-markdown-reader h2")?.textContent).toBe("Fresh preview");
      expect(
        panel.querySelector(".sidebar-markdown-shell__toolbar button")?.textContent?.trim(),
      ).toBe("View Raw Text");
    } finally {
      for (const [index, [, delay]] of schedule.mock.calls.entries()) {
        if (delay === 1_500) {
          globalThis.clearTimeout(schedule.mock.results[index]?.value);
        }
      }
      schedule.mockRestore();
      panel.remove();
    }
  });

  it.each([
    { sessionKey: undefined, action: "click" },
    { sessionKey: "agent:research:report", action: "click" },
    { sessionKey: undefined, action: "Enter" },
  ])(
    "opens workspace files from markdown previews owned by $sessionKey with $action",
    async ({ sessionKey, action }) => {
      const onOpenWorkspaceFile = vi.fn();
      const panel = await mountPanel(
        {
          kind: "markdown",
          content: "See `src/file.ts:362`",
          fileLinkSessionKey: sessionKey,
        },
        { onOpenWorkspaceFile },
      );
      const link = panel.querySelector<HTMLAnchorElement>("a.markdown-file-link");
      if (action === "Enter") {
        link?.focus();
        expect(document.activeElement).toBe(link);
        activate(link, action);
        expect(onOpenWorkspaceFile).toHaveBeenCalledOnce();
      } else {
        link?.click();
      }
      expect(onOpenWorkspaceFile).toHaveBeenCalledWith({
        path: "src/file.ts",
        line: 362,
        ...(sessionKey ? { sessionKey } : {}),
      });
    },
  );

  it("handles markdown preview session links with click", async () => {
    const onOpenSessionLink = vi.fn();
    const sessionKey = "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6";
    const panel = await mountPanel(
      { kind: "markdown", content: `Open \`${sessionKey}\`` },
      { onOpenSessionLink },
    );
    const link = panel.querySelector<HTMLAnchorElement>("a.markdown-session-link");
    link?.setAttribute("href", "/chat/roboclaw/2139bddb");
    activate(link, "click");
    expect(onOpenSessionLink).toHaveBeenCalledWith({ sessionKey, agentId: "roboclaw" });
  });

  it.each(["click", "Enter"])(
    "SPA-routes markdown preview session hrefs with %s",
    async (action) => {
      const onOpenSessionLink = vi.fn();
      const literalUuid = "12345678-90ab-cdef-1234-567890abcdef";
      const href = `${window.location.origin}/control/dashboard/main/~key/${literalUuid}`;
      const panel = await mountPanel(
        { kind: "markdown", content: `[Open session](${href})` },
        { basePath: "/control", onOpenSessionLink },
      );
      const link = panel.querySelector<HTMLAnchorElement>(`a[href^="${window.location.origin}"]`);
      activate(link, action);
      expect(onOpenSessionLink).toHaveBeenCalledWith({
        namespace: "dashboard",
        pathname: `/control/dashboard/main/~key/${literalUuid}`,
      });
    },
  );

  it.each(["markdown", "image"] as const)(
    "opens %s images only through its owner's lightbox or fallback",
    async (kind) => {
      const src = "data:image/png;base64,cG5n";
      const title = kind === "markdown" ? "Preview" : "Artifact preview";
      const content: SidebarContent =
        kind === "markdown" ? { kind, content: `![${title}](${src})` } : { kind, title, src };
      const selector =
        kind === "markdown"
          ? ".markdown-inline-image-button"
          : ".chat-tool-card__preview-image-button";
      const onOpenImage = vi.fn();
      const panel = await mountPanel(content, { onOpenImage });
      query<HTMLButtonElement>(panel, selector)?.click();
      expect(onOpenImage).toHaveBeenCalledWith({ src, title });
      panel.remove();
      const fallbackPanel = await mountPanel(content);
      const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
      if (kind === "markdown") {
        expect(query(fallbackPanel, selector)).toBeNull();
      } else {
        query<HTMLButtonElement>(fallbackPanel, selector)?.click();
        expect(openSpy).toHaveBeenCalledWith(src, "_blank", "noopener,noreferrer");
      }
      openSpy.mockRestore();
    },
  );

  it("preserves authenticated transcoded video playback in Files", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const panel = await mountPanel({
      kind: "attachment",
      title: "clip.mov",
      src: "/api/chat/media/outgoing/session/artifact/full?mediaTicket=ticket",
      sourceIdentity: "artifact:clip",
      mimeType: "video/quicktime",
      playback: "transcode",
      authToken: "session-token",
      width: 9,
      height: 16,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof Request ? url.url : url?.toString()).toContain("playback=1");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
    expect(panel.querySelector("openclaw-chat-video-player")).toMatchObject({
      mediaWidth: 9,
      mediaHeight: 16,
    });
    expect(panel.querySelector(":scope > video")).toBeNull();
  });

  it("plays normalized base64 audio from Files", async () => {
    const panel = await mountPanel({
      kind: "attachment",
      attachmentKind: "audio",
      title: "inline.wav",
      src: "data:audio/wav;base64,UklGRg==",
      mimeType: "audio/wav",
    });
    const player = panel.querySelector("openclaw-chat-audio-player");
    expect(player?.src).toBe("data:audio/wav;base64,UklGRg==");
  });

  it.each([
    ["bundle.zip", "https://files.example/bundle.zip", "application/zip"],
    ["external.html", "https://files.example/external.html", "text/html"],
    ["external.pdf", "https://files.example/external.pdf", "application/pdf"],
  ] as const)(
    "renders document %s as a Files card without previewing it",
    async (title, src, mimeType) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      const panel = await mountPanel(attachment({ title, src, mimeType }));
      expect(panel.querySelector("iframe, table, audio, video")).toBeNull();
      expect(panel.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull();
      const download = downloadButton(panel);
      expect(download.getAttribute("href")).toBe(src);
      expect(download).toMatchObject({ target: "_blank", rel: "noreferrer" });
      expect(download.textContent).toContain("Download");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("shows a failed attachment download and lets the user retry", async () => {
    const pending = createDeferred<Blob>();
    const retry = createDeferred<Blob>();
    const download = vi.fn(() => retry.promise).mockReturnValueOnce(pending.promise);
    const panel = await mountPanel(attachment({ download }));
    const button = downloadButton(panel);
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(true));
    pending.reject(new Error("Download interrupted"));
    await vi.waitFor(() => {
      expect(button.disabled).toBe(false);
      expect(panel.querySelector('[role="alert"]')?.textContent).toBe("Download interrupted");
    });
    button.click();
    await vi.waitFor(() => {
      expect(button.disabled).toBe(true);
      expect(panel.querySelector('[role="alert"]')).toBeNull();
    });
    expect(download).toHaveBeenCalledTimes(2);
  });

  it.each(["selection", "disconnection"])(
    "retires an attachment download on %s before late bytes arrive",
    async (change) => {
      const pending = createDeferred<Blob>();
      let signal!: AbortSignal;
      const content = attachment({
        download: (requestSignal: AbortSignal) => {
          signal = requestSignal;
          return pending.promise;
        },
      });
      const createObjectURL = vi.fn();
      vi.stubGlobal(
        "URL",
        class extends URL {
          static override createObjectURL = createObjectURL;
        },
      );
      const panel = await mountPanel(content);
      downloadButton(panel).click();
      if (change === "selection") {
        panel.content = { kind: "markdown", content: "Next" };
        await panel.updateComplete;
      } else {
        panel.remove();
        await Promise.resolve();
      }
      expect(signal.aborted).toBe(true);
      pending.resolve(new Blob(["late content"]));
      await Promise.resolve();
      expect(createObjectURL).not.toHaveBeenCalled();
    },
  );

  it("preserves image placeholders and ignores stale image events", async () => {
    let pending = true;
    let src = "/diagram.png";
    const content = {
      kind: "attachment",
      attachmentKind: "image",
      title: "diagram.png",
      mimeType: "image/png",
      width: 600,
      height: 400,
      resolveSource: () => (pending ? { status: "pending" } : { status: "ready", src }),
    } satisfies SidebarContent;
    const panel = await mountPanel(content);
    await vi.waitFor(() => expect(panel.querySelector('[role="status"]')).not.toBeNull());
    const presentation = panel.querySelector('[role="status"]');
    const header = panel.querySelector(".chat-assistant-attachment-card__header");
    pending = false;
    panel.content = { ...panel.content };
    const image = await vi.waitFor(() =>
      expectDefined(panel.querySelector(".sidebar-attachment-preview__image"), "Preview image"),
    );
    expect(panel.querySelector('[role="status"]')).toBe(presentation);
    expect(panel.querySelector(".chat-assistant-attachment-card__header")).toBe(header);
    image.dispatchEvent(new Event("error"));
    expect(image.getAttribute("data-preview")).toBe("error");
    src = "/next.png";
    panel.content = { ...panel.content };
    const next = await vi.waitFor(() => {
      const current = expectDefined(
        panel.querySelector(".sidebar-attachment-preview__image"),
        "Next preview image",
      );
      expect(current).not.toBe(image);
      return current;
    });
    image.dispatchEvent(new Event("load"));
    expect(next.hasAttribute("data-preview")).toBe(false);
    panel.remove();
    next.dispatchEvent(new Event("load"));
    container.append(panel);
    expect(next.getAttribute("data-preview")).toBe("ready");
  });

  it.each([
    { title: "vector.svg", mimeType: "image/svg+xml", src: "https://x.test/a.svg" },
    { title: "diagram", mimeType: undefined, src: "https://x.test/a.svg" },
    {
      title: "vector.svg",
      mimeType: "application/octet-stream",
      src: "https://x.test/opaque",
    },
  ])(
    "keeps external SVG attachments as Files cards with title $title and MIME $mimeType",
    async ({ title, mimeType, src }) => {
      const panel = await mountPanel(attachment({ attachmentKind: "image", title, src, mimeType }));
      expect(panel.querySelector(".sidebar-attachment-preview__image")).toBeNull();
      expect(downloadButton(panel).getAttribute("href")).toBe(src);
    },
  );

  it("keeps a canvas scripts ceiling under a trusted global sandbox", async () => {
    const content = {
      kind: "canvas",
      docId: "preview-1",
      title: "Preview",
      entryUrl: "https://canvas.example/previews/preview-1",
      sandbox: "scripts",
    } satisfies SidebarContent;
    const panel = await mountPanel(content, {
      embedSandboxMode: "trusted",
      canvasPluginSurfaceUrl: "https://canvas.example",
    });
    const frame = panel.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    panel.content = { ...content, title: "Renamed preview" };
    await panel.updateComplete;
    expect(panel.querySelector("iframe")).toBe(frame);
    expect(frame?.title).toBe("Renamed preview");
    panel.content = { ...content, sandbox: "strict" };
    await panel.updateComplete;
    expect(panel.querySelector("iframe")).not.toBe(frame);
    expect(panel.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
  });
});

describe("file sidebar clipboard feedback", () => {
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

  const mountFilePanel = () => mountPanel(file());

  const findCopyButton = (panel: DetailPanel, label: string) =>
    expectDefined(query<HTMLButtonElement>(panel, `button[aria-label="${label}"]`), label);

  function denyClipboard() {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    return { execCommand, writeText };
  }

  function captureFeedbackTimers() {
    const schedule = vi.spyOn(globalThis, "setTimeout");
    return {
      schedule,
      run(delay: number, index = 0) {
        const timerIndex = schedule.mock.calls
          .map(([, timeout], callIndex) => (timeout === delay ? callIndex : -1))
          .filter((callIndex) => callIndex >= 0)[index];
        if (timerIndex === undefined) {
          throw new Error(`Missing sidebar clipboard reset timer after ${delay}ms`);
        }
        const reset = schedule.mock.calls[timerIndex]?.[0];
        if (typeof reset !== "function") {
          throw new Error(`Expected sidebar clipboard reset timer after ${delay}ms`);
        }
        globalThis.clearTimeout(schedule.mock.results[timerIndex]?.value);
        reset();
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalExecCommand) {
      Object.defineProperty(document, "execCommand", originalExecCommand);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
    document.body.replaceChildren();
  });

  it("ignores an older successful path copy after a failed retry", async () => {
    const label = "Copy path";
    const { writeText } = denyClipboard();
    const first = createDeferred<void>();
    writeText.mockReturnValueOnce(first.promise);
    const panel = await mountFilePanel();
    const button = findCopyButton(panel, label);
    button.click();
    button.click();
    await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copy failed"));
    first.resolve();
    await settle(panel);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Copy failed");
  });

  it("keeps path and contents feedback reset timers independent", async () => {
    denyClipboard();
    const panel = await mountFilePanel();
    const pathButton = findCopyButton(panel, "Copy path");
    const contentsButton = findCopyButton(panel, "Copy file contents");
    const timers = captureFeedbackTimers();
    pathButton.click();
    contentsButton.click();
    await vi.waitFor(() => {
      expect(pathButton.getAttribute("aria-label")).toBe("Copy failed");
      expect(contentsButton.getAttribute("aria-label")).toBe("Copy failed");
    });
    timers.run(2_000);
    await panel.updateComplete;
    expect(pathButton.getAttribute("aria-label")).toBe("Copy path");
    expect(contentsButton.getAttribute("aria-label")).toBe("Copy failed");
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Copy failed");
    timers.run(2_000, 1);
    await panel.updateComplete;
    expect(contentsButton.getAttribute("aria-label")).toBe("Copy file contents");
    expect(panel.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["file selection", "disconnection"])(
    "ignores a delayed successful copy after %s changes its owner",
    async (change) => {
      const pending = createDeferred<void>();
      const writeText = vi.fn(() => pending.promise);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const panel = await mountFilePanel();
      const button = findCopyButton(panel, "Copy file contents");
      const timers = captureFeedbackTimers();
      button.click();
      if (change === "file selection") {
        panel.content = file("src/next.ts", "const next = true;");
        await panel.updateComplete;
      } else {
        panel.remove();
      }
      pending.resolve();
      await settle(panel);
      expect(timers.schedule.mock.calls.some(([, delay]) => delay === 1_500)).toBe(false);
      expect(button.getAttribute("aria-label")).toBe("Copy file contents");
      expect(panel.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it.each([false, true])(
    "restores idle feedback on reconnection with a pending copy: %s",
    async (pendingCopy) => {
      const label = "Copy file contents";
      const pending = createDeferred<void>();
      const writeText = vi.fn(() => pending.promise);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const panel = await mountFilePanel();
      const button = findCopyButton(panel, label);
      const timers = captureFeedbackTimers();
      button.click();
      if (!pendingCopy) {
        pending.resolve();
        await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copied!"));
        timers.schedule.mockClear();
      }
      panel.remove();
      // Let the bridge retire the disconnected root before reconnecting this host.
      await Promise.resolve();
      container.append(panel);
      await panel.updateComplete;
      pending.resolve();
      await settle(panel);
      expect(findCopyButton(panel, label).getAttribute("aria-label")).toBe(label);
      expect(findCopyButton(panel, label).classList.contains("copied")).toBe(false);
      expect(timers.schedule.mock.calls.some(([, delay]) => delay === 1_500)).toBe(false);
      expect(panel.querySelector('[role="alert"]')).toBeNull();
    },
  );
});

describe("file sidebar HTML preview ownership", () => {
  it("restores preview mode on file replacement and source mode on line navigation", async () => {
    const panel = document.createElement("openclaw-chat-detail-panel");
    const first = {
      kind: "file" as const,
      path: "first.html",
      name: "first.html",
      content: "<h1>First</h1>",
    };
    panel.content = first;
    container.append(panel);
    const preview = () =>
      expectDefined(
        panel.querySelector<ChatHtmlPreviewElement>("openclaw-chat-html-preview"),
        "HTML preview",
      );
    const previewContainer = () =>
      expectDefined(panel.querySelector<HTMLElement>(".chat-html-preview"), "Preview container");
    const toggle = () =>
      expectDefined(
        Array.from(panel.querySelectorAll("button")).find(
          (button) =>
            button.textContent?.trim() === "Source" || button.textContent?.trim() === "Preview",
        ),
        "Preview toggle",
      );
    await waitForSolid(() => expect(preview().html).toBe(first.content));
    expect(previewContainer().hidden).toBe(false);
    toggle().click();
    await waitForSolid(() => expect(previewContainer().hidden).toBe(true));
    const search = expectDefined(
      panel.querySelector<HTMLButtonElement>(".sidebar-file-view__search-toggle"),
      "Search toggle",
    );
    search.click();
    await waitForSolid(() =>
      expect(document.activeElement).toBe(panel.querySelector('input[type="search"]')),
    );
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await waitForSolid(() => expect(document.activeElement).toBe(search));
    toggle().click();
    await waitForSolid(() => expect(previewContainer().hidden).toBe(false));
    panel.content = { ...first, path: "next.html", name: "next.html", content: "<h1>Next</h1>" };
    await waitForSolid(() => expect(preview().html).toBe("<h1>Next</h1>"));
    panel.fileNavigation = { line: 1 };
    await waitForSolid(() => expect(previewContainer().hidden).toBe(true));
    toggle().click();
    await waitForSolid(() => expect(previewContainer().hidden).toBe(false));
    expect(preview().html).toBe("<h1>Next</h1>");
  });

  it("previews a retained edit and restores its source when opened at a line", async () => {
    const content = {
      kind: "file" as const,
      path: "draft.html",
      name: "draft.html",
      content: "<h1>Saved</h1>",
      draftKey: "html-preview-draft",
      edit: { hash: "saved", save: vi.fn(), fetchLatest: vi.fn() },
    };
    setFileDraft(content, { content: "<h1>Draft</h1>", expectedHash: "saved" });
    try {
      const panel = document.createElement("openclaw-chat-detail-panel");
      panel.content = content;
      container.append(panel);
      await waitForSolid(() =>
        expect(
          panel.querySelector<ChatHtmlPreviewElement>("openclaw-chat-html-preview")?.html,
        ).toBe("<h1>Draft</h1>"),
      );
      panel.content = { ...content, line: 1 };
      await waitForSolid(() =>
        expect(panel.querySelector<HTMLElement>(".chat-html-preview")?.hidden).toBe(true),
      );
      expect(panel.querySelector(".file-view")?.hasAttribute("hidden")).toBe(false);
    } finally {
      setFileDraft(content, null);
    }
  });
});
