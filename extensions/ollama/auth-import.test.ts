import { afterEach, describe, expect, it, vi } from "vitest";

// mock-isolation: Fail if either import path loads the broad provider-auth SDK entrypoint.
vi.mock("openclaw/plugin-sdk/provider-auth", () => {
  throw new Error("Ollama registration and streaming must not load the broad provider-auth SDK");
});

afterEach(() => {
  vi.resetModules();
});

describe("Ollama auth import boundary", () => {
  it("loads the plugin entry without the broad provider-auth SDK", async () => {
    const { default: plugin } = await import("./index.js");
    expect(plugin.register).toBeTypeOf("function");
  });

  it("loads the real stream runtime without the broad provider-auth SDK", async () => {
    const { createConfiguredOllamaStreamFn } = await import("./src/stream.runtime.js");
    expect(createConfiguredOllamaStreamFn).toBeTypeOf("function");
  });
});
