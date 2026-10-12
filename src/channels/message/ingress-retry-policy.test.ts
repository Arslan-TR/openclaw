// Retry policy: backoff, attempt floor + age gate for dead-letter.
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  resolveIngressFailureDisposition,
  resolveIngressRetryDelayMs,
  shouldDeadLetterRetryableIngressEvent,
} from "./ingress-retry-policy.js";

describe("ingress retry policy", () => {
  it("caps the retry exponent independently of the configured maximum", () => {
    const expected = [
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 256_000,
    ];
    expect(
      expected.map((_, index) =>
        resolveIngressRetryDelayMs(
          {
            receivedAt: 0,
            attempts: index + 1,
            lastAttemptAt: 0,
            lastError: "boom",
          },
          { baseMs: 1_000, maxMs: 1_000_000 },
          0,
        ),
      ),
    ).toEqual(expected);
  });

  it("retries immediately without a prior error", () => {
    expect(resolveIngressRetryDelayMs({ receivedAt: 0, attempts: 2 }, undefined, 10_000)).toBe(0);
  });

  it("does not dead-letter an old event below the attempt floor", () => {
    const receivedAt = 1_000;
    expect(
      shouldDeadLetterRetryableIngressEvent(
        { receivedAt },
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
        undefined,
        receivedAt + DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS + 1,
      ),
    ).toBe(false);
  });

  it("disposition prefers non-retryable fail", () => {
    const disposition = resolveIngressFailureDisposition({
      err: new Error("missing harness"),
      event: { receivedAt: Date.now() - 60_000, attempts: 0 },
      formatError: (err) => String(err),
      resolveNonRetryableFailure: () => ({
        reason: "missing-agent-harness",
        message: "missing harness",
      }),
    });
    expect(disposition).toEqual({
      kind: "fail",
      reason: "missing-agent-harness",
      message: "missing harness",
      attempt: 1,
    });
  });

  it("disposition dead-letters only when both gates pass", () => {
    const receivedAt = 1_000;
    // Attempt floor met, age gate not → keep retrying.
    const young = resolveIngressFailureDisposition({
      err: new Error("transient"),
      event: {
        receivedAt,
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
      },
      formatError: coerceErrorMessage,
      now: receivedAt + DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS - 1,
    });
    expect(young.kind).toBe("release");

    // Both gates met → dead-letter.
    const aged = resolveIngressFailureDisposition({
      err: new Error("transient"),
      event: {
        receivedAt,
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
      },
      formatError: coerceErrorMessage,
      now: receivedAt + DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    });
    expect(aged).toMatchObject({
      kind: "fail",
      reason: "retry-limit-exceeded",
      attempt: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
    });
  });

  it("dead-letters a restart tombstone by structured code instead of wording", () => {
    const message = "This generation is terminal.";
    const wrapped = Object.assign(new Error("BotError in middleware"), {
      error: new Error("telegram spooled update processing failed", {
        cause: Object.assign(new Error(message), {
          code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
        }),
      }),
    });
    expect(
      resolveIngressFailureDisposition({
        err: wrapped,
        event: { receivedAt: 1_000, attempts: 0 },
        formatError: coerceErrorMessage,
        config: { maxAttempts: 8, deadLetterMinAgeMs: 24 * 60 * 60 * 1000 },
        now: 2_000,
      }),
    ).toEqual({
      kind: "fail",
      reason: "restart-recovery-tombstone",
      message: wrapped.message,
      attempt: 1,
    });
    expect(
      resolveIngressFailureDisposition({
        err: Object.assign(new Error(message), {
          code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
        }),
        event: { receivedAt: 1_000, attempts: 425 },
        formatError: coerceErrorMessage,
        now: 2_000,
      }),
    ).toMatchObject({ kind: "fail", reason: "restart-recovery-tombstone", attempt: 426 });
  });

  it("bounds a wrapped session-start conflict at the configured attempt budget", () => {
    const maxAttempts = 3;
    const message = 'Session "agent:main:telegram:direct:1" changed while starting work. Retry.';
    const conflict = Object.assign(new Error(message), {
      code: "SESSION_WORK_START_CHANGED",
    });
    const wrapped = Object.assign(new Error("BotError in middleware"), {
      error: new Error("telegram spooled update processing failed", { cause: conflict }),
    });
    const beforeLimit = resolveIngressFailureDisposition({
      err: wrapped,
      event: {
        receivedAt: 1_000,
        attempts: maxAttempts - 2,
      },
      formatError: coerceErrorMessage,
      config: { maxAttempts },
      now: 2_000,
    });
    expect(beforeLimit).toMatchObject({
      kind: "release",
      attempt: maxAttempts - 1,
    });
    expect(
      resolveIngressFailureDisposition({
        err: new Error(message),
        event: { receivedAt: 1_000, attempts: maxAttempts - 1 },
        formatError: coerceErrorMessage,
        config: { maxAttempts },
        now: 2_000,
      }),
    ).toMatchObject({ kind: "release", attempt: maxAttempts });
    expect(
      resolveIngressFailureDisposition({
        err: Object.assign(new Error(message), { code: "SESSION_WORK_START_INVALIDATED" }),
        event: { receivedAt: 1_000, attempts: maxAttempts - 1 },
        formatError: coerceErrorMessage,
        config: { maxAttempts },
        now: 2_000,
      }),
    ).toMatchObject({ kind: "release", attempt: maxAttempts });

    const atLimit = resolveIngressFailureDisposition({
      err: wrapped,
      event: {
        receivedAt: 1_000,
        attempts: maxAttempts - 1,
      },
      formatError: coerceErrorMessage,
      config: { maxAttempts },
      now: 2_000,
    });
    expect(atLimit).toEqual({
      kind: "fail",
      reason: "session-start-conflict-retry-limit",
      message: wrapped.message,
      attempt: maxAttempts,
    });
  });
});
