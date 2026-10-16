/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import { getSessionWorkspace, loadSessionWorkspace } from "./chat-session-workspace-state.ts";
import type { SessionWorkspaceProps } from "./chat-session-workspace-types.ts";
import {
  createSessionWorkspaceProps,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

function createWorkspace(overrides: Partial<SessionWorkspaceProps> = {}): SessionWorkspaceProps {
  return {
    sessionKey: "agent:main:workspace",
    list: null,
    loading: false,
    error: null,
    activeId: null,
    filter: "all",
    browserPath: "",
    browserSearch: "",
    onBrowsePath: vi.fn(),
    onOpenFile: vi.fn(),
    onSearch: vi.fn(),
    onSetFilter: vi.fn(),
    onOpenArtifact: vi.fn(),
    ...overrides,
  };
}

function mountWorkspace(workspace: SessionWorkspaceProps) {
  const [current, setCurrent] = createSignal(workspace);
  const view = mountSolid(() => <SessionWorkspaceRail workspace={current()} />);
  return {
    ...view,
    update(this: void, next: SessionWorkspaceProps) {
      setCurrent({ ...next });
      flush();
    },
  };
}

type WorkspaceFile = NonNullable<SessionWorkspaceProps["list"]>["files"][number];
function file(path: string, kind: WorkspaceFile["kind"] = "modified"): WorkspaceFile {
  return { path, name: path.split(/[\\/]/).at(-1)!, kind, missing: false };
}

function artifact(id: string, title: string) {
  return { id, title, type: "file", download: { mode: "bytes" as const } };
}

function fileNames(mount: ParentNode) {
  return Array.from(
    mount.querySelectorAll(".chat-workspace-rail__file-name"),
    (row) => row.textContent,
  );
}

function button(mount: ParentNode, label: string) {
  return mount.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("session workspace path actions", () => {
  it.each([
    { path: "reports/monthly", search: "", loading: false, parent: "reports" },
    { path: "reports", search: "", loading: true, parent: null },
  ])("keeps only settled non-root folder recovery available: %j", (scenario) => {
    const onBrowsePath = vi.fn();
    const workspace = createWorkspace({
      browserPath: scenario.path,
      browserSearch: scenario.search,
      loading: scenario.loading,
      list: { sessionKey: "agent:main:workspace", root: "/workspace", files: [] },
      onBrowsePath,
    });
    const { container: mount } = mountWorkspace(workspace);
    const parent = mount.querySelector<HTMLButtonElement>('button[aria-label=".."]');
    if (scenario.parent === null) {
      expect(parent).toBeNull();
      expect(mount.textContent).not.toContain("This folder is unavailable.");
    } else {
      expect(parent).not.toBeNull();
      expect(mount.textContent).toContain("This folder is unavailable.");
      parent!.click();
      expect(onBrowsePath).toHaveBeenCalledExactlyOnceWith(scenario.parent);
    }
  });

  it("keeps path-only rows selected and their actions focused after read and refresh", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const entry = file("README.md");
    const result = { sessionKey: "agent:main:current", root: "/workspace", files: [entry] };
    const state = {
      client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) },
      connected: true,
      handleOpenSidebar: vi.fn(),
      hello: null,
      agentsList: [],
      sessionKey: result.sessionKey,
      sidebarContent: null,
      sessions: {
        listFiles: vi.fn().mockResolvedValue(result),
        getFile: vi.fn().mockResolvedValue({
          ...result,
          file: { ...entry, previewKind: "text", contentEncoding: "utf8", content: "# Readme" },
        }),
      },
    } as unknown as SessionWorkspaceHost;
    createSessionWorkspaceProps(state, { expanded: true });
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).list).not.toBeNull());
    const { container, update } = mountWorkspace(
      createSessionWorkspaceProps(state, { expanded: true }),
    );
    const renderRows = () => update(createSessionWorkspaceProps(state, { expanded: true }));
    renderRows();
    const preview = button(container, "Preview");
    assert(preview);
    preview.focus();
    preview.click();
    await vi.waitFor(() =>
      expect(state.sessionWorkspaceState?.previews[0]?.content.kind).toBe("file"),
    );
    renderRows();
    expect(container.querySelector(".chat-workspace-rail__file--active")?.textContent).toContain(
      "README.md",
    );
    expect(document.activeElement).toBe(preview);
    const copy = button(container, "Copy path");
    assert(copy);
    copy.focus();
    copy.click();
    await vi.waitFor(() => expect(copy.getAttribute("aria-label")).toBe("Copied!"));
    loadSessionWorkspace(state, getSessionWorkspace(state), true);
    await vi.waitFor(() => expect(createSessionWorkspaceProps(state).loading).toBe(false));
    renderRows();
    expect(container.querySelector(".chat-workspace-rail__file--active")?.textContent).toContain(
      "README.md",
    );
    expect(document.activeElement).toBe(copy);
    expect(container.querySelector('button[aria-label="Copied!"]')).toBe(copy);
    expect(copy.parentElement?.querySelector('[role="status"]')?.textContent).toBe("Copied!");
  });

  it.each(["C:\\synthetic\\very-long-workspace-prefix"])(
    "keeps session file labels readable and distinct under %s",
    async (root) => {
      const separator = "\\";
      const path = (...parts: string[]) => [root, ...parts].join(separator);
      const paths = [path("inventory.csv"), path("ui", "index.ts"), path("api", "index.ts")];
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const onOpenFile = vi.fn();
      const workspace = createWorkspace({
        list: {
          sessionKey: "agent:main:workspace",
          root,
          files: paths.map((filePath, index) => file(filePath, index === 2 ? "read" : "modified")),
        },
        activeId: `file:${paths[1]}`,
        onOpenFile,
      });
      const { container: mount, update } = mountWorkspace(workspace);
      const renderRows = () => update(workspace);
      const labels = () => fileNames(mount);
      renderRows();
      expect(labels()).toEqual([
        "inventory.csv",
        `ui${separator}index.ts`,
        `api${separator}index.ts`,
      ]);
      const rows = [...mount.querySelectorAll(".chat-workspace-rail__file")];
      for (const [index, row] of rows.entries()) {
        const open = row.querySelector<HTMLButtonElement>(".chat-workspace-rail__file-open")!;
        expect(open.getAttribute("aria-label")).toBe(paths[index]);
        expect(row.querySelector("openclaw-tooltip")?.content).toBe(paths[index]);
        open.click();
        expect(onOpenFile).toHaveBeenLastCalledWith(paths[index], "session");
        row.querySelector<HTMLButtonElement>('button[aria-label="Copy path"]')!.click();
        await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(paths[index]));
      }
      const selectedRow = rows[1];
      assert(selectedRow, "Expected the selected ui/index.ts row");
      expect(selectedRow.classList.contains("chat-workspace-rail__file--active")).toBe(true);
      workspace.filter = "changed";
      renderRows();
      expect(labels()).toEqual(["inventory.csv", `ui${separator}index.ts`]);
      workspace.browserSearch = `ui${separator}index`;
      renderRows();
      expect(labels()).toEqual([`ui${separator}index.ts`]);
    },
  );

  it("shows Copy failed when copying a session Files path", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onOpenFile = vi.fn();
    const workspace = createWorkspace({
      list: {
        sessionKey: "agent:main:workspace",
        root: "/synthetic/project",
        files: [file("src/edited.ts")],
        browser: {
          path: "",
          entries: [{ kind: "file", name: "browser.ts", path: "src/browser.ts" }],
        },
      },
      onOpenFile,
    });
    const { container: mount } = mountWorkspace(workspace);

    const row = mount.querySelector<HTMLElement>(
      ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser) .chat-workspace-rail__file",
    );
    expect(row).toBeInstanceOf(HTMLElement);
    const rowClick = vi.fn();
    row!.addEventListener("click", rowClick);
    const copy = button(row!, "Copy path");
    expect(copy).toBeInstanceOf(HTMLButtonElement);

    copy!.click();
    await vi.waitFor(() => expect(copy!.getAttribute("aria-label")).toBe("Copy failed"));

    expect(writeText).toHaveBeenCalledWith("src/edited.ts");
    const feedback = copy!.parentElement?.querySelector<HTMLElement>('[role="status"]');
    expect(feedback?.textContent).toBe("Copy failed");
    expect(feedback?.hidden).toBe(false);
    expect(rowClick).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();

    const preview = button(row!, "Preview");
    expect(preview).toBeInstanceOf(HTMLButtonElement);
    preview!.click();
    expect(onOpenFile).toHaveBeenCalledWith("src/edited.ts", "session");
  });

  it("preserves disclosure toggles across renders and opens matching groups during search", () => {
    const workspace = createWorkspace({
      list: {
        sessionKey: "agent:main:workspace",
        files: [file("src/edited.ts")],
        artifacts: [
          {
            id: "portrait-1",
            title: "Portrait",
            mimeType: "image/jpeg",
            type: "image",
            download: { mode: "bytes" },
            sizeBytes: 2048,
          },
        ],
      },
    });
    const { container: mount, update } = mountWorkspace(workspace);
    const [changed, artifacts] = mount.querySelectorAll("details");
    assert(changed && artifacts, "Expected Changed and Artifacts disclosures");
    expect(changed.open).toBe(true);
    expect(artifacts.open).toBe(false);
    changed.querySelector("summary")!.click();
    artifacts.querySelector("summary")!.click();

    update({ ...workspace, activeId: "artifact:portrait-1" });

    expect(changed.open).toBe(false);
    expect(artifacts.open).toBe(true);
    artifacts.querySelector("summary")!.click();
    workspace.browserSearch = "IMAGE";
    update(workspace);

    expect(mount.querySelectorAll(".chat-workspace-rail__group")).toHaveLength(1);
    expect(mount.querySelector("summary")?.textContent).toContain("Artifacts");
    expect(mount.querySelector("details")?.open).toBe(true);
    expect(mount.textContent).toContain("Portrait");
    expect(mount.querySelector('button[aria-label="src/edited.ts"]')).toBeNull();
    expect(mount.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("IMAGE");

    workspace.browserSearch = "";
    update(workspace);
    mount.querySelector("summary")!.click();
    expect(mount.querySelector("details")?.open).toBe(false);
    update({ ...workspace, filter: "changed" });

    expect(mount.querySelectorAll("details")).toHaveLength(1);
    expect(mount.querySelector("details")?.open).toBe(true);
    expect(mount.querySelector('button[aria-label="src/edited.ts"]')).not.toBeNull();
  });

  it.each([
    { filter: "changed", browser: true, restored: 1 },
    { filter: "read", browser: true, restored: 1 },
    { filter: "artifacts", browser: true, restored: 1 },
    { filter: "all", browser: true, restored: 3 },
    { filter: "all", browser: false, restored: 3 },
  ] as const)(
    "explains empty $filter search results (browser: $browser) and recovers",
    (scenario) => {
      const workspace = createWorkspace({
        list: {
          sessionKey: "agent:main:workspace",
          files: [file("report.csv"), file("report.md", "read")],
          artifacts: [artifact("report", "Report")],
          ...(scenario.browser ? { browser: { path: "", entries: [] } } : {}),
        },
      });
      const { container: mount, update } = mountWorkspace(workspace);
      const renderRows = () => update(workspace);
      workspace.onSearch = (search) => {
        workspace.browserSearch = search;
        if (workspace.list?.browser) {
          workspace.list.browser.search = search;
        }
        renderRows();
      };
      workspace.onSetFilter = (filter) => {
        workspace.filter = filter;
        renderRows();
      };
      renderRows();
      const search = mount.querySelector<HTMLInputElement>('input[type="search"]')!;
      search.value = "NO-SUCH-FILE";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      const label = scenario.filter === "all" ? "All" : `1 ${scenario.filter}`;
      const chip = [...mount.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      assert(chip, "Expected the selected Files filter to remain available");
      chip.click();
      expect(mount.querySelectorAll(".chat-workspace-rail__file-name")).toHaveLength(0);
      expect(mount.textContent?.match(/No matching files\./g)).toHaveLength(1);
      expect(chip.getAttribute("aria-pressed")).toBe("true");

      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      expect(mount.querySelectorAll(".chat-workspace-rail__file-name")).toHaveLength(
        scenario.restored,
      );
      expect(mount.textContent).not.toContain("No matching files.");
      expect(chip.getAttribute("aria-pressed")).toBe("true");

      search.value = "NO-SUCH-FILE";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      workspace.loading = true;
      workspace.list = null;
      renderRows();
      expect(mount.textContent).not.toContain("No matching files.");
      workspace.loading = false;
      renderRows();
      expect(mount.textContent).not.toContain("No matching files.");
      workspace.error = "Files could not be loaded.";
      renderRows();
      expect(mount.textContent).toContain(workspace.error);
      expect(mount.textContent).not.toContain("No matching files.");
    },
  );

  it("matches every Files group without collapsing internal spaces", () => {
    const query = "  INVENTORY  REPORT  ";
    const workspace = createWorkspace({
      browserSearch: query,
      list: {
        sessionKey: "agent:main:workspace",
        files: [
          file("inventory  report.csv"),
          file("inventory  report.md", "read"),
          file("inventory report.csv"),
        ],
        artifacts: [artifact("report", "Inventory  report"), artifact("other", "Inventory report")],
        browser: {
          path: "",
          search: "inventory  report",
          entries: [{ kind: "file", name: "inventory  report.csv", path: "inventory  report.csv" }],
        },
      },
    });
    const { container: mount, update } = mountWorkspace(workspace);
    expect(fileNames(mount)).toEqual([
      "inventory  report.csv",
      "inventory  report.md",
      "Inventory  report",
      "inventory  report.csv",
    ]);
    expect(mount.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe(query);

    update({ ...workspace, browserSearch: "   " });
    expect(mount.querySelectorAll(".chat-workspace-rail__file-name")).toHaveLength(6);
  });
});
