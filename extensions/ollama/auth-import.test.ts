import { afterEach, describe, expect, it, vi } from "vitest";

// mock-isolation: Fail if either import path loads the broad provider-auth SDK entrypoint.
vi.mock("openclaw/plugin-sdk/provider-auth", () => {
  throw new Error("Ollama registration and streaming must not load the broad provider-auth SDK");
});
// mock-isolation: Secret resolution belongs to the async callbacks, not module registration.
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => {
  throw new Error("Ollama registration and streaming must not eagerly load secret resolution");
});

afterEach(() => {
  vi.resetModules();
});

describe("Ollama auth import boundary", () => {
  it("loads the plugin entry without broad auth or secret resolution runtimes", async () => {
    const { default: plugin } = await import("./index.js");
    expect(plugin.register).toBeTypeOf("function");
  });

  it("loads the real stream runtime without broad auth or secret resolution runtimes", async () => {
    const { createConfiguredOllamaStreamFn } = await import("./src/stream.runtime.js");
    expect(createConfiguredOllamaStreamFn).toBeTypeOf("function");
  });
});
