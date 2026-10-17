import { describe, expect, it, vi } from "vitest";
import {
  IncognitoSessionEndedError,
  IncognitoSessionSyncAccessError,
} from "../../state/incognito-session-error.js";
import { SessionManager } from "../sessions/session-manager.js";
import { createProviderReplaySessionState } from "./replay-session-state.js";

describe("awaited provider replay session state", () => {
  it("returns a receipt for its completed append", async () => {
    const manager = SessionManager.inMemory();
    const replay = createProviderReplaySessionState(manager);

    const id = await replay.state.appendCustomEntryAsync("fixture", { retained: true });

    expect(manager.getEntry(id)).toMatchObject({
      id,
      type: "custom",
      customType: "fixture",
      data: { retained: true },
    });
    replay.close();
  });

  it("rejects a closed adapter before writing", async () => {
    const manager = SessionManager.inMemory();
    const replay = createProviderReplaySessionState(manager);
    replay.close();

    await expect(replay.state.appendCustomEntryAsync("fixture", {})).rejects.toThrow(
      "Provider replay session state is no longer active",
    );
    expect(manager.getEntries()).toEqual([]);
  });
});

describe("legacy provider replay session state", () => {
  it.each([
    new IncognitoSessionSyncAccessError("appendCustomEntry", "appendCustomEntryAsync"),
    new IncognitoSessionEndedError(),
  ])("propagates $name instead of pretending the session is empty or persisted", (failure) => {
    const manager = SessionManager.inMemory();
    vi.spyOn(manager, "getEntries").mockImplementation(() => {
      throw failure;
    });
    vi.spyOn(manager, "appendCustomEntry").mockImplementation(() => {
      throw failure;
    });
    const replay = createProviderReplaySessionState(manager);

    expect(() => replay.state.getCustomEntries()).toThrow(failure);
    expect(() => replay.state.appendCustomEntry("fixture", {})).toThrow(failure);
    replay.close();
  });

  it("retains the released adapter's ordinary failure tolerance", () => {
    const manager = SessionManager.inMemory();
    vi.spyOn(manager, "getEntries").mockImplementation(() => {
      throw new Error("legacy unavailable view");
    });
    vi.spyOn(manager, "appendCustomEntry").mockImplementation(() => {
      throw new Error("legacy persistence failure");
    });
    const replay = createProviderReplaySessionState(manager);

    expect(replay.state.getCustomEntries()).toEqual([]);
    expect(() => replay.state.appendCustomEntry("fixture", {})).not.toThrow();
    replay.close();
  });
});
