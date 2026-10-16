import { describe, expect, it, vi } from "vitest";
import {
  removeConfigFormValue,
  serializeFormForSubmit,
  updateConfigFormValue,
} from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import { renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import type { JsonSchema } from "./config-form.shared.ts";
import {
  anyOf,
  analyzeProperties,
  byText,
  edit,
  expectElement,
  object,
  query,
} from "./config-form.test-support.ts";

describe("config form map integrity", () => {
  it("round-trips the agent model Code Mode field without losing sibling settings", () => {
    const modelSettings = (codeMode?: boolean) => ({
      alias: "test",
      params: { temperature: 0.5 },
      agentRuntime: { id: "openclaw" },
      streaming: false,
      ...(codeMode === undefined ? {} : { codeMode }),
    });
    const config = (codeMode?: boolean) => ({
      agents: {
        entries: {
          ops: {
            models: {
              "example/model.v1": modelSettings(codeMode),
              "example/other": { alias: "other" },
            },
            tools: { codeMode: { enabled: "auto", maxOutputBytes: 4096 } },
          },
        },
      },
      tools: { codeMode: { enabled: "auto", maxOutputBytes: 4096 } },
    });
    const modelSchema = object({
      tools: object({
        codeMode: anyOf(
          { type: "boolean" },
          { const: "auto" },
          { type: "object", additionalProperties: true },
        ),
      }),
      models: {
        type: "object",
        additionalProperties: object({
          alias: { type: "string" },
          params: object({ temperature: { type: "number" } }),
          agentRuntime: object({ id: { type: "string" } }),
          streaming: { type: "boolean" },
          codeMode: { type: "boolean" },
        }),
      },
    });
    const analysis = analyzeProperties({
      agents: object({
        entries: {
          type: "object",
          propertyNames: { type: "string", pattern: "^[a-z0-9_][a-z0-9_-]{0,63}$" },
          additionalProperties: modelSchema,
        },
      }),
    });
    const state = createInitialConfigState();
    state.configSchema = analysis.schema;
    state.configForm = config();
    const container = document.createElement("div");
    const renderValue = () =>
      renderAnalyzedFormFixture(container, analysis, {
        uiHints: {
          "agents.defaults.models.*.codeMode": { label: "Code Mode", placeholder: "Default" },
          "agents.entries.*.models.*.codeMode": { label: "Code Mode", placeholder: "Default" },
        },
        value: state.configForm,
        onPatch: (path, value) => updateConfigFormValue(state, path, value),
        onRemove: (path) => removeConfigFormValue(state, path),
      });
    const getSelect = () => query<HTMLSelectElement>(container, 'select[aria-label="Code Mode"]');

    renderValue();
    expect(container.textContent).toContain("Unsupported schema node. Use Raw mode.");
    expect(Array.from(getSelect().options, (option) => option.textContent?.trim())).toEqual([
      "Default",
      "On",
      "Off",
    ]);
    expect(getSelect().selectedOptions[0]?.textContent?.trim()).toBe("Default");
    const streamingRow = Array.from(container.querySelectorAll(".settings-row--toggle")).find(
      (row) => row.querySelector(".settings-row__title")?.textContent?.trim() === "Streaming",
    );
    expect(streamingRow?.querySelector('.settings-toggle__input[role="switch"]')).toBeTruthy();

    for (const [label, value] of [
      ["On", true],
      ["Off", false],
      ["Default", undefined],
    ] as const) {
      const select = getSelect();
      const option = expectElement(
        Array.from(select.options).find((entry) => entry.textContent?.trim() === label),
        label,
      );
      edit(select, option.value, "change");
      expect(JSON.parse(serializeFormForSubmit(state))).toEqual(config(value));
      renderValue();
      expect(getSelect().selectedOptions[0]?.textContent?.trim()).toBe(label);
    }
  });

  it("keeps plain-string record keys editable through nested maps", () => {
    const analysis = analyzeProperties({
      values: {
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: { type: "string" },
        },
      },
    });

    expect(analysis.unsupportedPaths).toEqual([]);

    const container = document.createElement("div");
    const onPatch = vi.fn();
    renderAnalyzedFormFixture(container, analysis, {
      value: { values: { primary: { region: "west" } } },
      onPatch,
    });

    expect(container.querySelectorAll(".cfg-map")).toHaveLength(2);
    expect(container.textContent).not.toContain("Unsupported schema node");

    const nestedKey = query<HTMLInputElement>(container, '[aria-label="Key: region"]');
    edit(nestedKey, "zone", "change");
    expect(onPatch).toHaveBeenCalledWith(["values", "primary"], { zone: "west" });
  });

  it.each([
    ["null", null],
    ["wrong type", { type: "number" }],
    ["unknown constraint", { type: "string", not: { const: "blocked" } }],
  ])("keeps %s property-name constraints fail-closed", (_label, propertyNames) => {
    const analysis = analyzeProperties({
      values: {
        type: "object",
        propertyNames,
        additionalProperties: { type: "string" },
      },
    });

    expect(analysis.unsupportedPaths).toEqual(["values"]);
  });

  it.each([
    { label: "pattern", names: { type: "string", pattern: "^[a-z]+$" }, invalid: "bad/key" },
    { label: "enumeration", names: { enum: ["primary", "backup"] }, invalid: "other" },
  ])("rejects $label key edits even when an existing value is invalid", ({ names, invalid }) => {
    const analysis = analyzeProperties({
      values: {
        type: "object",
        propertyNames: names,
        additionalProperties: { type: "string", pattern: "^[0-9]+$" },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
    const state = createInitialConfigState();
    state.configSchema = analysis.schema;
    state.configForm = { values: { primary: "invalid existing value" } };
    const onPatch = vi.fn((path: Array<string | number>, value: unknown) =>
      updateConfigFormValue(state, path, value),
    );
    const container = document.createElement("div");
    document.body.append(container);
    try {
      renderAnalyzedFormFixture(container, analysis, {
        value: state.configForm,
        onPatch,
      });
      const keyInput = query<HTMLInputElement>(container, '[aria-label="Key: primary"]');
      edit(keyInput, invalid, "change");
      expect(keyInput.value).toBe("primary");
      expect(onPatch).not.toHaveBeenCalled();

      const draft = query(container, "openclaw-config-form-collection-draft");
      byText<HTMLElement>(container, "button", "Add Entry").click();
      flush();
      const key = query<HTMLInputElement>(draft, "[data-collection-draft-key]");
      const value = query<HTMLInputElement>(draft, "[data-collection-draft-value]");
      edit(key, invalid);
      edit(value, "123");
      flush();
      byText<HTMLElement>(draft, "button", "Add Entry").click();
      flush();
      expect(key.getAttribute("aria-invalid")).toBe("true");
      expect(key.value).toBe(invalid);
      expect(onPatch).not.toHaveBeenCalled();
      edit(key, "backup");
      flush();
      byText<HTMLElement>(draft, "button", "Add Entry").click();
      expect(state.configForm).toEqual({
        values: { primary: "invalid existing value", backup: "123" },
      });
    } finally {
      container.remove();
    }
  });

  it("keeps supported map children editable beside Raw-only fields", () => {
    const rowSchema = object({
      name: { type: "string" },
      retained: anyOf({ type: "number" }, { const: false }),
    }) satisfies JsonSchema;
    const collection = (name: string) => ({ "example/model.v1": { name, retained: false } });
    const analysis = analyzeProperties({
      values: { type: "object", additionalProperties: rowSchema },
    });
    expect(analysis.unsupportedPaths).toEqual(["values.*.retained"]);
    const state = createInitialConfigState();
    state.configSchema = analysis.schema;
    state.configForm = { values: collection("before") };
    const container = document.createElement("div");
    renderAnalyzedFormFixture(container, analysis, {
      value: state.configForm,
      onPatch: (path, value) => updateConfigFormValue(state, path, value),
    });
    expect(container.textContent).toContain("Unsupported schema node. Use Raw mode.");
    expect(container.querySelector('[aria-label="Retained"]')).toBeNull();
    const name = query<HTMLInputElement>(container, '[aria-label="Name"]');
    edit(name, "after");
    expect(JSON.parse(serializeFormForSubmit(state))).toEqual({ values: collection("after") });
  });
});
