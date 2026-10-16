import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { flushLogger, getChildLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { recordTalkLogEvent } from "./logging.js";
import { recordTalkObservabilityEvent } from "./observability.js";
import { createTalkEventSequencer } from "./talk-events.js";

const TALK_CONTEXT = {
  sessionId: "talk-session",
  mode: "realtime",
  transport: "gateway-relay",
  brain: "agent-consult",
  provider: "openai",
} as const;

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

type LogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;
type ObservedDiagnostic = { event: DiagnosticEventPayload; trusted: boolean };

function stableDiagnosticPayload<TEvent extends DiagnosticEventPayload>(
  event: TEvent,
): Omit<TEvent, "seq" | "trace" | "ts"> {
  expect(event.seq).toBeGreaterThan(0);
  expect(event.ts).toBeGreaterThan(0);
  const { seq: _seq, ts: _ts, trace, ...stable } = event;
  expect(trace).toBeUndefined();
  return stable;
}

function stableLogRecordPayload(event: LogRecord) {
  const { code, loggerParents, ...stable } = stableDiagnosticPayload(event);
  expect(loggerParents).toStrictEqual(["openclaw"]);
  expect(code?.functionName).toMatch(/^[A-Za-z0-9_.:-]+$/u);
  expect(code?.line).toBeGreaterThan(0);
  return stable;
}

function requireObservedDiagnostic<TType extends DiagnosticEventPayload["type"]>(
  observed: readonly ObservedDiagnostic[],
  type: TType,
): { event: Extract<DiagnosticEventPayload, { type: TType }>; trusted: boolean } {
  const event = observed.find(
    (
      entry,
    ): entry is { event: Extract<DiagnosticEventPayload, { type: TType }>; trusted: boolean } =>
      entry.event.type === type,
  );
  if (!event) {
    throw new Error(`Expected ${type} diagnostic event`);
  }
  return event;
}

describe("talk logging", () => {
  let tmpDir: string;
  let logFile: string;
  let observed: ObservedDiagnostic[];
  let unsubscribe: () => void;
  const logs = () => observed.flatMap(({ event }) => (event.type === "log.record" ? [event] : []));

  function expectLog(event: LogRecord, type: string, level: string, extra = {}) {
    expect(stableLogRecordPayload(event)).toStrictEqual({
      type: "log.record",
      level,
      message: `talk event ${type}`,
      attributes: {
        subsystem: "talk",
        sessionId: "talk-session",
        talkEventType: type,
        talkMode: "realtime",
        talkTransport: "gateway-relay",
        talkBrain: "agent-consult",
        talkProvider: "openai",
        talkFinal: true,
        ...extra,
      },
    });
  }
  function expectPrivateFieldsAbsent(serialized: string) {
    for (const text of ["private transcript", "turn-1", "call-1", "item-1"]) {
      expect(serialized).not.toContain(text);
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-talk-logs-"));
    logFile = path.join(tmpDir, "openclaw.log");
    resetDiagnosticEventsForTest();
    resetLogger();
    setLoggerOverride({ level: "info", file: logFile });
    observed = [];
    unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
      observed.push({ event, trusted: metadata.trusted });
    });
  });

  afterEach(async () => {
    await flushLogger();
    unsubscribe();
    resetDiagnosticEventsForTest();
    setLoggerOverride(null);
    resetLogger();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits bounded lifecycle log records without transcript text or scoped ids", async () => {
    const events = createTalkEventSequencer(TALK_CONTEXT);
    const talkEvent = events.next({
      type: "output.text.done",
      turnId: "turn-1",
      callId: "call-1",
      itemId: "item-1",
      final: true,
      payload: {
        text: "private transcript should not be logged",
        durationMs: 42,
      },
    });

    recordTalkLogEvent(talkEvent);
    await flushDiagnosticEvents();
    unsubscribe();

    expect(logs()).toHaveLength(1);
    expectLog(expectDefined(logs()[0], "Talk diagnostic log"), "output.text.done", "INFO", {
      talkDurationMs: 42,
    });
    expectPrivateFieldsAbsent(JSON.stringify(logs()[0]));

    // Other subsystems share the file sink and can log after diagnostic collection ends.
    getChildLogger({ subsystem: "sibling" }).info("unrelated lifecycle event");

    // The file transport appends asynchronously; drain it before reading.
    await flushLogger();
    const fileLog = fs.readFileSync(logFile, "utf8");
    const fileLogRecords = fileLog
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const talkRecords = fileLogRecords.filter((record) => record["0"] === '{"subsystem":"talk"}');
    expect(talkRecords).toHaveLength(1);
    const fileLogRecord = expectDefined(talkRecords[0], "Talk file log record");
    expect(fileLogRecord).toMatchObject({
      message: "talk event output.text.done",
      session_id: "talk-session",
    });
    expect(fileLogRecords).toContainEqual(
      expect.objectContaining({ message: "unrelated lifecycle event" }),
    );
    expectPrivateFieldsAbsent(fileLog);
  });

  it("drops high-volume delta records from file and OTLP logs", async () => {
    const events = createTalkEventSequencer(TALK_CONTEXT);

    recordTalkLogEvent(
      events.next({
        type: "transcript.delta",
        turnId: "turn-1",
        payload: { text: "private partial transcript" },
      }),
    );
    recordTalkLogEvent(
      events.next({
        type: "output.audio.delta",
        turnId: "turn-1",
        payload: { byteLength: 320 },
      }),
    );
    await flushDiagnosticEvents();
    unsubscribe();

    expect(logs()).toHaveLength(0);
  });

  it("records diagnostics and logs through the combined observability hook", async () => {
    const events = createTalkEventSequencer(TALK_CONTEXT);

    recordTalkObservabilityEvent(
      events.next({
        type: "session.error",
        payload: { message: "provider failure with private detail" },
        final: true,
      }),
    );
    await flushDiagnosticEvents();
    unsubscribe();

    expect(observed).toHaveLength(2);
    const talkEvent = requireObservedDiagnostic(observed, "talk.event");
    const logRecord = requireObservedDiagnostic(observed, "log.record");
    expect(talkEvent.trusted).toBe(true);
    expect(stableDiagnosticPayload(talkEvent.event)).toStrictEqual({
      type: "talk.event",
      sessionId: "talk-session",
      turnId: undefined,
      captureId: undefined,
      talkEventType: "session.error",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      final: true,
      durationMs: undefined,
      byteLength: undefined,
    });
    expect(logRecord.trusted).toBe(false);
    expectLog(logRecord.event, "session.error", "WARN");
    expect(JSON.stringify(observed)).not.toContain("private detail");
  });
});
