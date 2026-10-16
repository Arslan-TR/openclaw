// Control UI tests cover array draft recovery and repeated-item constraints.
import { describe, expect, it, vi } from "vitest";
import { renderArrayFixture } from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import type { JsonSchema } from "./config-form.shared.ts";
import {
  anyOf,
  oneOf,
  array,
  byText,
  edit,
  expectElement,
  object,
  query,
} from "./config-form.test-support.ts";

describe("config form array integrity", () => {
  it("applies safe whole-array composition candidates atomically", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: array({ type: "string" }, { allOf: [{ const: ["a", "b"] }] }),
      value: undefined,
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    byText<HTMLButtonElement>(container, "button", "Add").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["a", "b"]);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: array({ type: "string" }, { enum: [[], ["a", "b"]] }),
      value: [],
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    byText<HTMLButtonElement>(container, "button", "Add").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["a", "b"]);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: array({ type: "string", default: "item" }, { default: ["a", "b"] }),
      value: [],
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    byText<HTMLButtonElement>(container, "button", "Add").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["item"]);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: array({ type: "string" }, { const: ["a", "b"] }),
      value: [],
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    byText<HTMLButtonElement>(container, "button", "Add").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["a", "b"]);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: array({ type: "string" }, { const: [], maxItems: 0 }),
      value: undefined,
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    const emptyConstAdd = byText<HTMLButtonElement>(container, "button", "Add");
    expect(emptyConstAdd.disabled).toBe(false);
    emptyConstAdd.click();
    expect(onPatch).toHaveBeenCalledWith(["values"], []);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: array({ type: "string" }, { maxItems: 0 }),
      value: undefined,
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    const requiredEmptyAdd = byText<HTMLButtonElement>(container, "button", "Add");
    expect(requiredEmptyAdd.disabled).toBe(false);
    requiredEmptyAdd.click();
    expect(onPatch).toHaveBeenCalledWith(["values"], []);
  });

  it("preserves unquoted strings and decodes quoted strings in string-number arrays", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const identifier = "1048113311314608148";
    renderArrayFixture(container, {
      schema: array(oneOf({ enum: [identifier] }, { type: "number" })),
      value: [],
      path: ["allowFrom"],
      onPatch,
    });

    const draftHost = query(container, "openclaw-config-form-collection-draft");
    const addDraftValue = (value: string) => {
      byText<HTMLButtonElement>(container, "button", "Add").click();
      flush();
      const draftValue = query<HTMLInputElement | HTMLTextAreaElement>(
        draftHost,
        "[data-collection-draft-value]",
      );
      edit(draftValue, value);
      flush();
      byText<HTMLButtonElement>(draftHost, "button", "Add").click();
      flush();
    };

    addDraftValue(identifier);
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], [identifier]);
    expect(onPatch.mock.calls[0]?.[1]?.[0]).not.toBe(Number(identifier));
    onPatch.mockClear();
    addDraftValue(JSON.stringify(identifier));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], [identifier]);
    onPatch.mockClear();
    addDraftValue("1e5");
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], [100_000]);
    container.remove();
  });

  it("keeps large and unique array minimums incrementally editable", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const renderSchema = (schema: JsonSchema) => {
      renderArrayFixture(container, {
        schema,
        value: undefined,
        path: ["codes"],
        onPatch,
      });
    };

    renderSchema(array({ type: "string" }, { minItems: 101 }));
    const largeMinimumAdd = byText<HTMLButtonElement>(container, "button", "Add");
    expect(largeMinimumAdd.disabled).toBe(false);
    largeMinimumAdd.click();
    expect(onPatch).toHaveBeenCalledWith(["codes"], [""]);

    onPatch.mockClear();
    renderSchema(array({ type: "string" }, { minItems: 2, uniqueItems: true }));
    const draftHost = query(container, "openclaw-config-form-collection-draft");
    flush();
    byText<HTMLButtonElement>(container, "button", "Add").click();
    flush();
    const draftValue = query<HTMLInputElement>(draftHost, "[data-collection-draft-value]");
    edit(draftValue, "first");
    flush();
    byText<HTMLButtonElement>(draftHost, "button", "Add").click();
    expect(onPatch).toHaveBeenCalledWith(["codes"], ["first"]);

    // An autosave ack clones the form: identity churn with identical content
    // must not close an open draft mid-typing.
    byText<HTMLButtonElement>(container, "button", "Add").click();
    flush();
    const typedDraft = query<HTMLInputElement>(draftHost, "[data-collection-draft-value]");
    edit(typedDraft, "in-progress");
    flush();
    renderSchema(array({ type: "string" }, { minItems: 2, uniqueItems: true }));
    flush();
    const survivingDraft = draftHost.querySelector<HTMLInputElement>(
      "[data-collection-draft-value]",
    );
    expect(survivingDraft?.value).toBe("in-progress");

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: array({ type: "string" }, { minItems: 2, uniqueItems: true }),
      value: ["first"],
      path: ["codes"],
      onPatch,
    });
    const duplicateDraft = query(container, "openclaw-config-form-collection-draft");
    flush();
    byText<HTMLButtonElement>(container, "button", "Add").click();
    flush();
    const duplicateValue = query<HTMLInputElement>(duplicateDraft, "[data-collection-draft-value]");
    edit(duplicateValue, "first");
    flush();
    byText<HTMLButtonElement>(duplicateDraft, "button", "Add").click();
    flush();
    expect(duplicateValue.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();

    renderArrayFixture(container, {
      schema: array(
        { type: "string" },
        { minItems: 2, allOf: [{ items: { type: "string", pattern: "^[0-9]+$" } }] },
      ),
      value: undefined,
      path: ["codes"],
      onPatch,
    });
    const composedDraft = query(container, "openclaw-config-form-collection-draft");
    flush();
    byText<HTMLButtonElement>(container, "button", "Add").click();
    flush();
    const composedValue = query<HTMLInputElement>(composedDraft, "[data-collection-draft-value]");
    edit(composedValue, "abc");
    flush();
    const composedCommit = byText<HTMLButtonElement>(composedDraft, "button", "Add");
    composedCommit.click();
    flush();
    expect(composedValue.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();

    edit(composedValue, "123");
    flush();
    composedCommit.click();
    expect(onPatch).toHaveBeenCalledWith(["codes"], ["123"]);
    container.remove();
  });

  it("restores JSON rows when a collection constraint rejects the edit", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: array(anyOf({ type: "object" }, { type: "array" }), { uniqueItems: true }),
      value: [{ id: "first" }, { id: "second" }],
      path: ["entries"],
      onPatch,
    });

    const textareas = Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea"));
    expect(textareas).toHaveLength(2);
    const second = expectElement(textareas[1], "second JSON array item");
    edit(second, '{"id":"first"}');
    second.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(second.value).toContain('"second"');
    expect(second.getAttribute("aria-invalid")).toBe("false");
  });

  it("resets scalar and JSON drafts when the first equal primitive row is removed", () => {
    const scalarContainer = document.createElement("div");
    let scalarValue: unknown[] = ["same", "same"];
    const renderScalarValue = () => {
      renderArrayFixture(scalarContainer, {
        schema: array({ type: "string", minLength: 2 }),
        value: scalarValue,
        path: ["values"],
        onPatch: (_path, nextValue) => {
          scalarValue = nextValue as unknown[];
          renderScalarValue();
        },
      });
    };
    renderScalarValue();
    const scalarInput = query<HTMLInputElement>(scalarContainer, "input");
    edit(scalarInput, "x");
    expect(scalarInput.getAttribute("aria-invalid")).toBe("true");
    query<HTMLButtonElement>(scalarContainer, "button[aria-label='Remove item']").click();
    const remainingScalar = query<HTMLInputElement>(scalarContainer, "input");
    expect(remainingScalar.value).toBe("same");
    expect(remainingScalar.getAttribute("aria-invalid")).toBe("false");

    const jsonContainer = document.createElement("div");
    let jsonValue: unknown[] = [true, true];
    const renderJsonValue = () => {
      renderArrayFixture(jsonContainer, {
        schema: array({}),
        value: jsonValue,
        path: ["values"],
        onPatch: (_path, nextValue) => {
          jsonValue = nextValue as unknown[];
          renderJsonValue();
        },
      });
    };
    renderJsonValue();
    const jsonDraft = query<HTMLTextAreaElement>(jsonContainer, "textarea");
    edit(jsonDraft, "{");
    expect(jsonDraft.getAttribute("aria-invalid")).toBe("true");
    query<HTMLButtonElement>(jsonContainer, "button[aria-label='Remove item']").click();
    const remainingJson = query<HTMLTextAreaElement>(jsonContainer, "textarea");
    expect(remainingJson.value).toBe("true");
    expect(remainingJson.getAttribute("aria-invalid")).toBe("false");
  });

  it("adds null through nullable scalar collection drafts", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    renderArrayFixture(container, {
      schema: array({ type: ["string", "null"] }, { uniqueItems: true }),
      value: [""],
      path: ["values"],
      onPatch,
    });
    const draftHost = query(container, "openclaw-config-form-collection-draft");
    byText<HTMLButtonElement>(container, "button", "Add").click();
    flush();
    const nullToggle = query<HTMLInputElement>(draftHost, "[data-collection-draft-null]");
    nullToggle.checked = true;
    nullToggle.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(
      draftHost.querySelector<HTMLInputElement>("[data-collection-draft-value]")?.disabled,
    ).toBe(true);
    byText<HTMLButtonElement>(draftHost, "button", "Add").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["", null]);
    container.remove();
  });

  it("propagates rejected edits through nested constrained arrays", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: array(array({ type: "string" }), { uniqueItems: true }),
      value: [["alpha"], ["beta"]],
      path: ["groups"],
      onPatch,
    });

    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    expect(inputs).toHaveLength(2);
    const second = expectElement(inputs[1], "second nested array item");
    edit(second, "alpha");

    expect(onPatch).not.toHaveBeenCalled();
    expect(second.value).toBe("beta");
    expect(second.getAttribute("aria-invalid")).toBe("false");
  });

  it("resets a reused object row after array removal", () => {
    const container = document.createElement("div");
    const schema = array(
      object({
        name: { type: "string", minLength: 2 },
      }),
    );
    let currentValue: unknown[] = [{ name: "same" }, { name: "same" }];
    const renderValue = () => {
      renderArrayFixture(container, {
        schema,
        value: currentValue,
        path: ["entries"],
        onPatch: (_path, nextValue) => {
          currentValue = nextValue as unknown[];
          renderValue();
        },
      });
    };

    renderValue();
    const firstInput = query<HTMLInputElement>(container, "input");
    edit(firstInput, "x");
    expect(firstInput.getAttribute("aria-invalid")).toBe("true");

    const firstRemove = query<HTMLButtonElement>(container, "button[aria-label='Remove item']");
    firstRemove.click();

    const shiftedInput = query<HTMLInputElement>(container, "input");
    expect(shiftedInput.value).toBe("same");
    expect(shiftedInput.getAttribute("aria-invalid")).toBe("false");
    expect(currentValue).toEqual([{ name: "same" }]);
  });
});
