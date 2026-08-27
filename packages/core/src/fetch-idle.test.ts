import { describe, expect, test } from "bun:test";
import {
  createTimeoutAbortSignal,
  withDisabledFetchIdle,
  withLlmFetchDeadline,
} from "./fetch-idle";

describe("createTimeoutAbortSignal", () => {
  test("aborts a zero deadline on the next timer turn", async () => {
    const timeout = createTimeoutAbortSignal(0);

    expect(timeout.signal.aborted).toBe(false);
    await Bun.sleep(1);
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).toMatchObject({ name: "TimeoutError" });
    timeout.dispose();
  });

  test("clears a pending deadline so it does not abort later", async () => {
    const timeout = createTimeoutAbortSignal(20);
    timeout.dispose();
    await Bun.sleep(30);

    expect(timeout.signal.aborted).toBe(false);
  });
});

describe("withDisabledFetchIdle", () => {
  test("sets Bun idleTimeout to 0 and keeps the original init", () => {
    const init = withDisabledFetchIdle({ method: "POST" });

    expect(init.method).toBe("POST");
    expect(init.idleTimeout).toBe(0);
  });
});

describe("withLlmFetchDeadline", () => {
  test("attaches a deadline signal when the caller omitted one", () => {
    const init = withLlmFetchDeadline({ method: "POST" });

    expect(init.idleTimeout).toBe(0);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  test("aborts when the caller signal is already aborted", () => {
    const caller = new AbortController();
    caller.abort();
    const init = withLlmFetchDeadline({ signal: caller.signal });

    expect(init.signal?.aborted).toBe(true);
  });
});
