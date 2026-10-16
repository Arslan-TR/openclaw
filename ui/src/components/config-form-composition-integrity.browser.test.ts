import { describe, expect, it, onTestFinished, vi } from "vitest";
// Control UI tests cover schema composition that changes field requiredness.
import { renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.tsx";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import type { JsonSchema } from "./config-form.shared.ts";
import {
  scalar,
  oneOf,
  anyOf,
  analyzeProperties,
  array,
  object,
} from "./config-form.test-support.ts";

function expectValid(schema: JsonSchema, value: unknown, valid: boolean) {
  expect(isSupportedConfigValueValid(schema, value)).toBe(valid);
}

describe("config form composition integrity", () => {
  it("renders object fields guarded by a required-property exclusion", () => {
    const analysis = analyzeProperties(
      {
        github: object({ token: { type: "string" } }, { title: "GitHub", required: ["token"] }),
        people: array({ type: "string" }),
        peopleFile: { type: "string" },
      },
      { required: ["github"], not: { required: ["people", "peopleFile"] } },
    );

    expect(analysis.unsupportedPaths).toEqual([]);
    expectValid(
      analysis.schema ?? {},
      {
        github: { token: "secret" },
        people: ["alice"],
        peopleFile: "people.json",
      },
      false,
    );
    expectValid(
      analysis.schema ?? {},
      {
        github: { token: "secret" },
        people: ["alice"],
      },
      true,
    );

    const container = document.createElement("div");
    renderAnalyzedFormFixture(container, analysis, {
      value: {},
      onPatch: vi.fn(),
    });
    expect(container.textContent).toContain("Github");
    expect(container.textContent).not.toContain("Unsupported schema node");
  });

  it("renders finite boolean unions and string-or-literal unions while keeping constrained unions in Raw mode", () => {
    const analysis = analyzeProperties({
      retention: anyOf({ type: "string" }, { const: false }),
      guarded: anyOf({ type: "boolean", not: { const: true } }, { const: "auto" }),
      nullableBoolean: anyOf({ type: ["boolean", "null"] }, { const: "auto" }),
      nullableString: anyOf({ type: ["string", "null"] }, { type: "boolean", const: false }),
      ambiguousBooleanLabel: anyOf({ type: "boolean" }, { const: "true" }),
      overlappingOneOf: oneOf({ type: "boolean" }, { const: true }),
      overlappingAnyOf: anyOf({ type: "boolean" }, { const: true }),
      mode: {
        title: "Native Commands",
        default: "auto",
        anyOf: [{ type: "boolean" }, { type: "string", const: "auto" }],
      },
      plainMode: {
        title: "Plain Mode",
        enum: ["auto", "manual"],
      },
      disjointOneOf: oneOf({ type: "boolean" }, { const: "auto" }),
    });

    expect(analysis.unsupportedPaths).toEqual([
      "guarded",
      "nullableBoolean",
      "nullableString",
      "ambiguousBooleanLabel",
      "overlappingOneOf",
    ]);
    expect(analysis.schema?.properties).toMatchObject({
      retention: anyOf({ type: "string" }, { const: false }),
      mode: { enum: [true, false, "auto"], default: "auto" },
      overlappingOneOf: oneOf({ type: "boolean" }, { const: true }),
      overlappingAnyOf: { enum: [true, false] },
      disjointOneOf: { enum: [true, false, "auto"] },
    });

    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    onTestFinished(() => container.remove());
    renderAnalyzedFormFixture(container, analysis, {
      value: { retention: "30d", mode: "auto", plainMode: "auto" },
      onPatch,
    });

    const modeControl = container.querySelector(
      '.settings-segmented[role="radiogroup"][aria-label="Native Commands"]',
    );
    expect(modeControl).not.toBeNull();
    const modeOptions = [...(modeControl?.querySelectorAll(".settings-segmented__btn") ?? [])];
    expect(modeOptions.map((option) => option.textContent?.trim())).toEqual(["On", "Off", "Auto"]);
    expect(
      modeOptions.map((option) => option.querySelector<HTMLInputElement>("input")?.value),
    ).toEqual(["0", "1", "2"]);
    const plainModeControl = container.querySelector(
      '.settings-segmented[role="radiogroup"][aria-label="Plain Mode"]',
    );
    expect(
      [...(plainModeControl?.querySelectorAll(".settings-segmented__btn") ?? [])].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["auto", "manual"]);
    const offOption = modeControl?.querySelector<HTMLInputElement>(
      'input[type="radio"][value="1"]',
    );
    expect(offOption).not.toBeNull();
    offOption!.click();
    expect(onPatch).toHaveBeenCalledWith(["mode"], false);
  });

  it("keeps annotations harmless and items-only schemas form-unsafe", () => {
    const annotated = analyzeProperties(
      {
        name: { type: "string" },
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://example.test/config",
        examples: [{}],
        deprecated: false,
        readOnly: false,
        writeOnly: false,
      },
    );
    expect(annotated.unsupportedPaths).toEqual([]);

    const itemsOnly = analyzeProperties({
      value: {
        items: { type: "string" },
      },
    });
    expect(itemsOnly.unsupportedPaths).toEqual(["value"]);
    expect(itemsOnly.schema?.properties?.value?.type).toBeUndefined();

    const composedArrayItems = analyzeProperties({
      codes: array({ type: "string" }, { allOf: [{ items: { pattern: "^[0-9]+$" } }] }),
      nestedCodes: array({ type: "string" }, { allOf: [{ allOf: [{ minItems: 1 }] }] }),
      nullableCodes: {
        type: ["array", "null"],
        items: { type: "string" },
        allOf: [{ allOf: [{ minItems: 1 }] }],
      },
      nullOnlyCodes: {
        type: ["array", "null"],
        items: { type: "string" },
        allOf: [{ type: ["null"] }],
      },
      nestedConflict: array({ type: "string" }, { allOf: [{ allOf: [object({})] }] }),
    });
    expect(composedArrayItems.unsupportedPaths).toEqual([
      "nullableCodes",
      "nullOnlyCodes",
      "nestedConflict",
    ]);
    expect(composedArrayItems.schema?.properties?.codes?.allOf?.[0]?.type).toBe("array");
    const nullableCodes = composedArrayItems.schema?.properties?.nullableCodes;
    expect(nullableCodes?.allOf?.[0]?.nullable).toBe(true);
    expectValid(nullableCodes ?? {}, null, true);
    const nullOnlyCodes = composedArrayItems.schema?.properties?.nullOnlyCodes;
    expect(nullOnlyCodes?.allOf?.[0]?.type).toEqual(["null"]);
    expectValid(nullOnlyCodes ?? {}, null, true);
    expectValid(nullOnlyCodes ?? {}, ["123"], false);
    const nestedConflict = composedArrayItems.schema?.properties?.nestedConflict;
    expectValid(nestedConflict ?? {}, ["123"], false);
  });

  it("normalizes primitive type arrays without accepting structured or composed type arrays", () => {
    const analysis = analyzeProperties({
      numberFirst: { type: ["number", "string"] },
      stringFirst: { type: ["string", "number"] },
      nullable: { type: ["string", "number", "null"], minimum: 2, maxLength: 4 },
      structured: { type: ["object", "array"] },
      composed: { type: ["string", "number"], allOf: [{ minimum: 2 }] },
    });
    expect(analysis.unsupportedPaths).toEqual(["structured", "composed"]);
    expect(analysis.schema?.properties?.nullable).toMatchObject({
      nullable: true,
      minimum: 2,
      maxLength: 4,
    });
  });

  it("marks incompatible effective allOf child schemas as form-unsafe", () => {
    const analysis = analyzeProperties({
      settings: object(
        {
          mode: { type: "string" },
        },
        {
          allOf: [
            {
              properties: {
                mode: { type: "number" },
                constraintOnly: { const: "safe" },
              },
            },
          ],
        },
      ),
      mixedItems: array({ type: "string" }, { allOf: [{ items: { type: "number" } }] }),
    });
    expect(analysis.unsupportedPaths).toEqual([
      "settings.mode",
      "settings.constraintOnly",
      "mixedItems",
    ]);
  });

  it("preserves nullability inherited through allOf", () => {
    const analysis = analyzeProperties({
      inherited: {
        allOf: [{ type: ["string", "null"] }],
      },
      excludedByOuterType: scalar("string", { allOf: [{ type: ["string", "null"] }] }),
      unionTypeExcludesNull: scalar("string", { anyOf: [{ const: "fixed" }, { const: null }] }),
    });
    expect(analysis.unsupportedPaths).toEqual(["inherited"]);
    expect(analysis.schema?.properties).toMatchObject({
      inherited: { type: "string", nullable: true },
      excludedByOuterType: { type: "string", nullable: false },
      unionTypeExcludesNull: { nullable: false, enumIncludesNull: false },
    });
  });

  it("keeps type-less allOf fields unsafe and closed empty tuples repairable", () => {
    const analysis = analyzeProperties({
      unknown: { allOf: [{ minLength: 2 }] },
      empty: array([], { additionalItems: false }),
    });
    expect(analysis.unsupportedPaths).toEqual(["unknown"]);
    if (!analysis.schema) {
      return;
    }

    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderAnalyzedFormFixture(container, analysis, {
      value: { unknown: "raw-only", empty: ["invalid"] },
      onPatch,
    });
    const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Add",
    );
    expect(add?.disabled).toBe(true);
    const remove = container.querySelector<HTMLButtonElement>("button[aria-label='Remove item']");
    expect(remove?.disabled).toBe(false);
    remove?.click();
    expect(onPatch).toHaveBeenCalledWith(["empty"], []);
  });
});
