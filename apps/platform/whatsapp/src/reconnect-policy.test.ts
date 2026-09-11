import { describe, expect, test } from "bun:test";
import {
  extractDisconnectStatusCode,
  WhatsAppReconnectPolicy,
} from "./reconnect-policy";

describe("WhatsApp reconnect policy", () => {
  test("caps fast retries even when the connection repeatedly opens briefly", () => {
    const policy = new WhatsAppReconnectPolicy();
    const delays: Array<number | null> = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      policy.opened(attempt * 60_000);
      delays.push(policy.closed(408, attempt * 60_000 + 1000));
    }
    expect(delays).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 300_000, 300_000,
      300_000, 300_000,
    ]);
  });

  test("resets the budget only after a stable connection", () => {
    const policy = new WhatsAppReconnectPolicy();
    policy.closed(408, 0);
    policy.closed(408, 1);
    policy.opened(2);
    expect(policy.closed(428, 300_002)).toBe(1000);
  });

  test("requires operator recovery for invalid auth or replaced sessions", () => {
    for (const code of [401, 403, 411, 440, 500]) {
      const policy = new WhatsAppReconnectPolicy();
      expect(policy.closed(code)).toBeNull();
      expect(policy.isHalted).toBe(true);
      expect(policy.closed(408)).toBeNull();
    }
    expect(new WhatsAppReconnectPolicy().closed(515)).toBe(1000);
  });

  test("recognizes nested numeric and string transport codes without parsing messages", () => {
    for (const error of [
      { output: { statusCode: "401" } },
      { statusCode: 401 },
      { cause: { data: { status: 401 } } },
      { code: "401" },
    ]) {
      expect(extractDisconnectStatusCode({ error })).toBe(401);
    }
    expect(
      extractDisconnectStatusCode({ error: { message: "401 secret" } })
    ).toBeUndefined();
    expect(
      extractDisconnectStatusCode({
        error: { output: { statusCode: 401 } },
        statusCode: 408,
      })
    ).toBe(401);
    expect(
      extractDisconnectStatusCode({ statusCode: Number.NaN })
    ).toBeUndefined();
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(extractDisconnectStatusCode(cycle)).toBeUndefined();
  });
});
