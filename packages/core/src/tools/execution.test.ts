import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../contract";
import {
  executeProtectedTool,
  executeWithRetry,
  formatUserSafeErrorMessage,
  standardizeToolError,
} from "./execution";

describe("standardizeToolError", () => {
  test("categorizes abort/cancellation", () => {
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    const std = standardizeToolError(abortErr);
    expect(std.code).toBe("CANCELLED");
    expect(std.retryable).toBe(false);
  });

  test("categorizes timeouts", () => {
    const timeoutErr = new Error("Request timed out after 30000ms");
    timeoutErr.name = "TimeoutError";
    const std = standardizeToolError(timeoutErr);
    expect(std.code).toBe("TIMEOUT");
    expect(std.retryable).toBe(false);
  });

  test("categorizes not found (ENOENT)", () => {
    const std = standardizeToolError(
      new Error("ENOENT: no such file or directory")
    );
    expect(std.code).toBe("NOT_FOUND");
    expect(std.retryable).toBe(false);
  });

  test("categorizes permission denied (EACCES)", () => {
    const std = standardizeToolError(new Error("EACCES: permission denied"));
    expect(std.code).toBe("PERMISSION_DENIED");
    expect(std.retryable).toBe(false);
  });

  test("categorizes network errors as retryable", () => {
    const std = standardizeToolError(new Error("fetch failed: ECONNREFUSED"));
    expect(std.code).toBe("NETWORK_ERROR");
    expect(std.retryable).toBe(true);
  });

  test("categorizes rate limits and provider errors as retryable", () => {
    const std = standardizeToolError(new Error("429 rate limit exceeded"));
    expect(std.code).toBe("PROVIDER_ERROR");
    expect(std.retryable).toBe(true);
  });
});

describe("formatUserSafeErrorMessage", () => {
  test("returns friendly copy for cancellations and timeouts", () => {
    expect(
      formatUserSafeErrorMessage({
        code: "CANCELLED",
        message: "",
        retryable: false,
      })
    ).toContain("stopped by the user");
    expect(
      formatUserSafeErrorMessage({
        code: "TIMEOUT",
        message: "",
        retryable: false,
      })
    ).toContain("exceeded its time limit");
  });
});

describe("executeWithRetry", () => {
  test("retries retryable errors up to limit", async () => {
    let attempts = 0;
    const { result, retries } = await executeWithRetry(
      async (attempt) => {
        attempts += 1;
        if (attempt === 0) {
          throw new Error("ECONNREFUSED");
        }
        return "success";
      },
      { initialDelayMs: 10, maxRetries: 2 }
    );

    expect(attempts).toBe(2);
    expect(retries).toBe(1);
    expect(result).toBe("success");
  });

  test("does not retry non-retryable errors", async () => {
    let attempts = 0;
    try {
      await executeWithRetry(
        async () => {
          attempts += 1;
          throw new Error("ENOENT: no such file");
        },
        { initialDelayMs: 10, maxRetries: 2 }
      );
    } catch {
      // Expected
    }

    expect(attempts).toBe(1);
  });
});

describe("executeProtectedTool", () => {
  const sampleTool: ToolDefinition<{ input: string }, string> = {
    description: "Sample tool",
    name: "sample",
    async run(input) {
      if (input.input === "fail") {
        throw new Error("Validation failed");
      }
      return `Processed: ${input.input}`;
    },
  };

  test("executes successfully and tracks metadata", async () => {
    const res = await executeProtectedTool(sampleTool, { input: "hello" }, {});
    expect(res.success).toBe(true);
    expect(res.data).toBe("Processed: hello");
    expect(typeof res.metadata?.durationMs).toBe("number");
  });

  test("returns standard error on failure", async () => {
    const res = await executeProtectedTool(sampleTool, { input: "fail" }, {});
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("INVALID_ARGUMENT");
  });
});
