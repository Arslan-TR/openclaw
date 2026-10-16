import { describe, expect, it, vi } from "vitest";
// Control UI tests cover collection default provenance and editing behavior.
import {
  renderJsonTextareaFixture,
  renderArrayFixture,
  renderObjectFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { array, byText, edit, object, query } from "./config-form.test-support.ts";

describe("config form collection defaults", () => {
  it("shows and clears optional JSON defaults without authoring the inherited value", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const schema = {
      anyOf: [{ type: "object" as const }, { type: "array" as const }],
      default: { mode: "balanced" },
    };

    const renderValue = (value: unknown) =>
      renderJsonTextareaFixture(container, { schema, value, path: ["payload"], onPatch });
    renderValue({ mode: "custom" });

    expect(container.textContent).toContain('Default: {"mode":"balanced"}');
    const textarea = query<HTMLTextAreaElement>(container, "textarea");
    expect(textarea.value).toBe('{\n  "mode": "custom"\n}');
    edit(textarea, "", "change");
    expect(onPatch).toHaveBeenCalledWith(["payload"], undefined);

    onPatch.mockClear();
    renderValue(undefined);

    expect(container.textContent).not.toContain("Using default:");
    expect(container.querySelector(".settings-row__desc")).toBeNull();
    expect(query<HTMLTextAreaElement>(container, "textarea").value).toBe(
      '{\n  "mode": "balanced"\n}',
    );
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("shows optional array defaults and authors inherited items without dropping siblings", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn(() => false);
    const schema = array({ type: "string" as const }, { default: ["a", "b"] });

    const renderValue = (value: unknown) =>
      renderArrayFixture(container, { schema, value, path: ["values"], onPatch });
    renderValue(["custom"]);

    expect(container.textContent).toContain('Default: ["a","b"]');
    expect(container.textContent).toContain("1 item");
    expect(query<HTMLInputElement>(container, "input").value).toBe("custom");

    onPatch.mockClear();
    renderValue(undefined);

    expect(container.textContent).not.toContain("Using default:");
    expect(container.querySelector(".settings-row__desc")).toBeNull();
    expect(container.textContent).toContain("2 items");
    const inheritedInputs = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    expect(inheritedInputs.map((input) => input.value)).toEqual(["", ""]);
    expect(inheritedInputs.map((input) => input.placeholder)).toEqual(["Default: a", "Default: b"]);
    expect(onPatch).not.toHaveBeenCalled();

    edit(inheritedInputs[1]!, "custom", "input", true);
    expect(onPatch).toHaveBeenCalledWith(["values"], ["a", "custom"]);
  });

  it("authors a nested inherited array item without dropping sibling defaults", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const schema = array(
      object({
        name: { type: "string" as const, title: "Name" },
        details: object(
          {
            label: { type: "string" as const, title: "Label" },
            note: { type: "string" as const, title: "Note" },
          },
          { title: "Details" },
        ),
      }),
      {
        default: [
          { name: "alpha", details: { label: "one", note: "keep-one" } },
          { name: "beta", details: { label: "two", note: "keep-two" } },
        ],
      },
    );

    renderArrayFixture(container, {
      schema,
      value: undefined,
      path: ["entries"],
      onPatch,
    });

    const labels = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[aria-label='Label']"),
    );
    expect(labels).toHaveLength(2);
    edit(labels[0]!, "changed");

    expect(onPatch).toHaveBeenCalledExactlyOnceWith(
      ["entries"],
      [
        { name: "alpha", details: { label: "changed", note: "keep-one" } },
        { name: "beta", details: { label: "two", note: "keep-two" } },
      ],
    );
  });

  it("conceals sensitive collection defaults", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const hints = {
      "settings.profile": { sensitive: true },
      "settings.tokens": { sensitive: true },
    };

    renderObjectFixture(container, {
      schema: object(
        { apiKey: { type: "string" } },
        { title: "Profile", default: { apiKey: "default-secret" } },
      ),
      value: { apiKey: "authored-secret" },
      path: ["settings", "profile"],
      hints,
      revealSensitive: false,
      onPatch,
    });

    expect(container.textContent).not.toContain("default-secret");

    renderArrayFixture(container, {
      schema: array({ type: "string" }, { title: "Tokens", default: ["default-token"] }),
      value: ["authored-token"],
      path: ["settings", "tokens"],
      hints,
      revealSensitive: false,
      onPatch,
    });

    expect(container.textContent).not.toContain("default-token");
  });

  it("keeps optional object children inherited until edited", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();
    const schema = object({
      profile: object(
        {
          enabled: { type: "boolean" as const, title: "Enabled" },
          mode: { type: "string" as const, title: "Mode" },
        },
        { title: "Profile", default: { enabled: true, mode: "balanced" } },
      ),
      sibling: { type: "string" as const, title: "Sibling" },
    });

    const renderValue = (value: unknown) =>
      renderObjectFixture(container, { schema, value, path: ["settings"], onPatch, onRemove });
    renderValue({
      profile: { enabled: false, mode: "custom" },
      sibling: "preserved",
    });

    const profile = byText<HTMLElement>(container, "details", "Profile", false);
    expect(profile.textContent).not.toContain('{"enabled":true,"mode":"balanced"}');
    expect(onPatch).not.toHaveBeenCalled();

    onRemove.mockClear();
    renderValue({ sibling: "preserved" });

    const inheritedProfile = byText<HTMLElement>(container, "details", "Profile", false);
    expect(inheritedProfile.textContent).not.toContain('{"enabled":true,"mode":"balanced"}');
    const enabledRow = byText<HTMLElement>(inheritedProfile, ".settings-row", "Enabled", false);
    const modeRow = byText<HTMLElement>(inheritedProfile, ".settings-row", "Mode", false);
    expect(enabledRow.textContent).not.toContain("Using default:");
    expect(modeRow.textContent).not.toContain("Using default:");
    expect(query<HTMLInputElement>(modeRow, "input").placeholder).toBe("Default: balanced");
    expect(onRemove).not.toHaveBeenCalled();

    const modeInput = query<HTMLInputElement>(modeRow, "input");
    edit(modeInput, "custom", "input", true);
    expect(onPatch).toHaveBeenCalledWith(["settings", "profile"], {
      enabled: true,
      mode: "custom",
    });
  });
});
