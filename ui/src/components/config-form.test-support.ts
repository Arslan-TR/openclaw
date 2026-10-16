import { expect } from "vitest";
import { analyzeConfigSchema } from "./config-form.analyze.ts";
import type { JsonSchema } from "./config-form.shared.ts";

export function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

export function query<Tag extends keyof HTMLElementTagNameMap>(
  root: ParentNode,
  selector: Tag,
): HTMLElementTagNameMap[Tag];
export function query<T extends Element = Element>(root: ParentNode, selector: string): T;
export function query(root: ParentNode, selector: string): Element {
  return expectElement(root.querySelector(selector), selector);
}

export function byText<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
  text: string,
  exact = true,
): T {
  return expectElement(
    Array.from(root.querySelectorAll<T>(selector)).find((node) =>
      exact ? node.textContent?.trim() === text : node.textContent?.includes(text),
    ),
    `${selector}: ${text}`,
  );
}

export function edit(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  event = "input",
  composed = false,
) {
  control.value = value;
  control.dispatchEvent(new Event(event, { bubbles: true, composed }));
}

// Preserve raw shapes, including deliberately unsupported analyzer inputs.
export function object<Properties extends object, Options extends object>(
  properties: Properties,
  options?: Options,
) {
  return { type: "object", properties, ...options };
}

export function array<Items, Options extends object>(items: Items, options?: Options) {
  return { type: "array", items, ...options };
}

export function anyOf(...variants: JsonSchema[]) {
  return { anyOf: variants };
}

export function oneOf(...variants: JsonSchema[]) {
  return { oneOf: variants };
}

export function scalar<Type extends string | string[], Options extends object>(
  type: Type,
  options?: Options,
) {
  return { type, ...options };
}

export function analyzeProperties<Properties extends object, Options extends object>(
  properties: Properties,
  options?: Options,
) {
  return analyzeConfigSchema(object(properties, options));
}
