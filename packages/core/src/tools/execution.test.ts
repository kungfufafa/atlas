import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { globalApprovalGrantStore } from "../approval-grant";
import type { ToolDefinition } from "../contract";
import { computeActionHash } from "../risk-engine";
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
    expect(std.message).toContain("timed out after 30000ms");
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
    expect(
      standardizeToolError(
        new Error("goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://example.com")
      ).code
    ).toBe("NETWORK_ERROR");
    const std = standardizeToolError(new Error("fetch failed: ECONNREFUSED"));
    expect(std.code).toBe("NETWORK_ERROR");
    expect(std.retryable).toBe(true);
  });

  test("categorizes rate limits and provider errors as retryable", () => {
    const std = standardizeToolError(new Error("429 rate limit exceeded"));
    expect(std.code).toBe("PROVIDER_ERROR");
    expect(std.retryable).toBe(true);
  });

  test("handles hostile error objects without invoking throwing getters", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
        getPrototypeOf() {
          throw new Error("hostile prototype");
        },
      }
    );

    expect(standardizeToolError(hostile)).toEqual({
      code: "INTERNAL_ERROR",
      message: "Unknown tool execution error.",
      retryable: false,
    });
  });

  test("rejects unrecognized error codes instead of trusting arbitrary strings", () => {
    const standardized = standardizeToolError({
      code: "DELETE_EVERYTHING",
      message: "custom failure",
      retryable: true,
    });

    expect(standardized.code).toBe("INTERNAL_ERROR");
    expect(standardized.retryable).toBe(false);
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

  test("cancels an in-progress retry backoff", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = executeWithRetry(
      async () => {
        attempts += 1;
        throw new Error("transient custom failure");
      },
      {
        initialDelayMs: 1000,
        maxRetries: 2,
        retryableCodes: ["INTERNAL_ERROR"],
      },
      controller.signal
    );

    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toThrow(/aborted/i);
    expect(attempts).toBe(1);
  });

  test("never enters backoff when the signal aborts during an attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = executeWithRetry(
      async () => {
        attempts += 1;
        controller.abort(new Error("cancelled during attempt"));
        throw new Error("tool noticed cancellation");
      },
      {
        initialDelayMs: 1000,
        maxRetries: 2,
        retryableCodes: ["INTERNAL_ERROR"],
      },
      controller.signal
    );
    const timed = Promise.race([
      pending,
      Bun.sleep(50).then(() => {
        throw new Error("retry backoff was entered");
      }),
    ]);

    await expect(timed).rejects.toThrow("cancelled during attempt");
    expect(attempts).toBe(1);
  });

  test("retries a hostile rejection without letting its getters mask recovery", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
        getPrototypeOf() {
          throw new Error("hostile prototype");
        },
      }
    );
    let attempts = 0;

    const result = await executeWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(hostile);
        }
        return "recovered";
      },
      {
        initialDelayMs: 1,
        maxRetries: 2,
        retryableCodes: ["INTERNAL_ERROR"],
      }
    );

    expect(result).toEqual({ result: "recovered", retries: 1 });
    expect(attempts).toBe(2);
  });
});

describe("executeProtectedTool", () => {
  test("blocks a viewer even when no server callback is attached", async () => {
    let effects = 0;
    const result = await executeProtectedTool(
      {
        description: "Read tenant data",
        name: "read_probe",
        async run() {
          effects += 1;
          return { value: "private" };
        },
      },
      {},
      { orgId: "org_viewer", orgRole: "viewer", userId: "user_viewer" }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(effects).toBe(0);
  });
  test("honors final authorization for direct protected calls before any tool effect", async () => {
    let effects = 0;
    const result = await executeProtectedTool(
      {
        description: "Probe authorization",
        name: "read_probe",
        async run() {
          effects += 1;
          return { ok: true };
        },
      },
      {},
      {
        beforeToolCall: async () => {
          throw Object.assign(new Error("Access revoked"), {
            code: "PERMISSION_DENIED",
            retryable: false,
          });
        },
      }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(effects).toBe(0);
  });

  test("revalidates authorization before a safe retry after access is revoked", async () => {
    let revoked = false;
    let effects = 0;
    const result = await executeProtectedTool(
      {
        description: "Probe retry authorization",
        name: "read_probe",
        retryPolicy: { initialDelayMs: 1, maxRetries: 2 },
        async run() {
          effects += 1;
          revoked = true;
          throw Object.assign(new Error("Transient failure"), {
            code: "NETWORK_ERROR",
          });
        },
      },
      {},
      {
        beforeToolCall: async () => {
          if (revoked) {
            throw Object.assign(new Error("Access revoked"), {
              code: "PERMISSION_DENIED",
              retryable: false,
            });
          }
        },
      }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(effects).toBe(1);
  });
  test("reports truncation only when output was actually shortened", async () => {
    const text = "a".repeat(40_000);
    const base = { description: "Large result", name: "large_output" };
    const stringResult = await executeProtectedTool(
      { ...base, run: async () => text },
      {},
      {}
    );
    expect(stringResult.success).toBe(true);
    expect(stringResult.metadata?.truncated).toBe(true);
    expect(stringResult.data?.length).toBeLessThan(text.length);

    const objectResult = await executeProtectedTool(
      { ...base, run: async () => ({ content: text, cursor: "next-page" }) },
      {},
      {}
    );
    expect(objectResult.success).toBe(true);
    expect(objectResult.metadata?.truncated).toBe(false);
    expect(objectResult.data).toEqual({ content: text, cursor: "next-page" });
    expect(objectResult.metadata?.warnings).toHaveLength(1);
  });

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

  test("does not retry a read tool without an explicit retry policy", async () => {
    let attempts = 0;
    const tool: ToolDefinition<Record<string, never>, never> = {
      description: "Read without retry opt-in",
      name: "web_search",
      async run() {
        attempts += 1;
        throw new Error("ECONNREFUSED");
      },
    };

    const result = await executeProtectedTool(tool, {}, {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NETWORK_ERROR");
    expect(attempts).toBe(1);
  });

  test("never applies a retry policy to a known mutating tool", async () => {
    let attempts = 0;
    const tool: ToolDefinition<{ content: string; path: string }, never> = {
      description: "Write a file",
      name: "write_file",
      retryPolicy: {
        initialDelayMs: 1,
        maxRetries: 2,
        retryableCodes: ["INTERNAL_ERROR"],
      },
      async run() {
        attempts += 1;
        throw new Error("transient custom failure");
      },
    };

    const result = await executeProtectedTool(
      tool,
      { content: "data", path: "output.txt" },
      {}
    );

    expect(result.success).toBe(false);
    expect(attempts).toBe(1);
  });

  test("blocks mutating tools for channel guest principals", async () => {
    let attempts = 0;
    const tool: ToolDefinition<{ content: string; path: string }, string> = {
      description: "Write a file",
      name: "write_file",
      async run() {
        attempts += 1;
        return "written";
      },
    };

    const result = await executeProtectedTool(
      tool,
      { content: "data", path: "output.txt" },
      { userId: "user_channel_guest_0123456789abcdef" }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(attempts).toBe(0);
  });

  test("also blocks read-only tools for channel guest principals", async () => {
    let attempts = 0;
    const tool: ToolDefinition<Record<string, never>, number> = {
      description: "Calculate",
      name: "calculator",
      async run() {
        attempts += 1;
        return 42;
      },
    };

    const result = await executeProtectedTool(
      tool,
      {},
      {
        userId: "user_channel_guest_0123456789abcdef",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(attempts).toBe(0);
  });

  test("caps an explicit safe retry policy at two retries", async () => {
    let attempts = 0;
    const tool: ToolDefinition<Record<string, never>, never> = {
      description: "Retry-safe custom read",
      name: "custom_read_probe",
      retryPolicy: {
        initialDelayMs: 0,
        jitter: false,
        maxRetries: 20,
        retryableCodes: ["INTERNAL_ERROR"],
      },
      async run() {
        attempts += 1;
        throw new Error("transient custom failure");
      },
    };

    const result = await executeProtectedTool(tool, {}, {});

    expect(result.success).toBe(false);
    expect(attempts).toBe(3);
  });

  test("never applies a tool retry policy to irreversible actions", async () => {
    const input = { message: "hello", to: "external@example.com" };
    const grant = globalApprovalGrantStore.createGrant({
      actionHash: computeActionHash({ args: input, tool: "send_message" }),
      executionId: "execution_retry_gate",
      orgId: "org_retry_gate",
      sessionId: "session_retry_gate",
      userId: "user_retry_gate",
    });
    let attempts = 0;
    const tool: ToolDefinition<typeof input, never> = {
      description: "Send a message",
      name: "send_message",
      retryPolicy: {
        initialDelayMs: 1,
        maxRetries: 2,
        retryableCodes: ["INTERNAL_ERROR"],
      },
      async run() {
        attempts += 1;
        throw new Error("transient custom failure");
      },
    };

    try {
      const result = await executeProtectedTool(tool, input, {
        approvalGrantId: grant.id,
        orgId: "org_retry_gate",
        userId: "user_retry_gate",
      });

      expect(result.success).toBe(false);
      expect(attempts).toBe(1);
    } finally {
      globalApprovalGrantStore.clear();
    }
  });

  test("captures files created under artifacts when the tool names the path", async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "atlas-tool-artifact-")
    );

    try {
      const fileTool: ToolDefinition<
        Record<string, never>,
        { path: string }
      > = {
        description: "Create a deliverable without declaring metadata",
        name: "custom_file_maker",
        async run() {
          const artifactsDir = path.join(workspaceRoot, "artifacts");
          await mkdir(artifactsDir, { recursive: true });
          await writeFile(path.join(artifactsDir, "report.pdf"), "%PDF-1.4");
          await writeFile(
            path.join(artifactsDir, "report.pdf.atlas-meta.json"),
            "{}"
          );
          return { path: "artifacts/report.pdf" };
        },
      };

      const result = await executeProtectedTool(
        fileTool,
        {},
        {
          sessionId: "session_test",
          workspaceRoot,
        }
      );

      expect(result.artifacts).toEqual([
        expect.objectContaining({
          filename: "report.pdf",
          mimeType: "application/pdf",
          path: "artifacts/report.pdf",
          sessionId: "session_test",
          sizeBytes: 8,
        }),
      ]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  test("does not stamp another session's overlapping artifact onto this result", async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "atlas-tool-artifact-overlap-")
    );
    const artifactsDir = path.join(workspaceRoot, "artifacts");
    let started!: () => void;
    let release!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await mkdir(artifactsDir, { recursive: true });
      const fileTool: ToolDefinition<{ path: string }, { path: string }> = {
        description: "Write one named deliverable",
        name: "custom_file_maker",
        async run(input) {
          await writeFile(path.join(artifactsDir, "report.pdf"), "%PDF-1.4");
          started();
          await releaseGate;
          return { path: input.path };
        },
      };

      const execution = executeProtectedTool(
        fileTool,
        { path: "artifacts/report.pdf" },
        {
          sessionId: "session_guest_a",
          workspaceRoot,
        }
      );
      await startedGate;
      await writeFile(
        path.join(artifactsDir, "secret-contract.pdf"),
        "%PDF-secret"
      );
      release();

      const result = await execution;
      expect(result.success).toBe(true);
      expect(result.artifacts).toEqual([
        expect.objectContaining({
          path: "artifacts/report.pdf",
          sessionId: "session_guest_a",
        }),
      ]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  test("does not attribute undeclared artifact writes from a directory scan", async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), "atlas-tool-artifact-undeclared-")
    );

    try {
      const fileTool: ToolDefinition<Record<string, never>, string> = {
        description: "Create a deliverable without naming it",
        name: "custom_file_maker",
        async run() {
          const artifactsDir = path.join(workspaceRoot, "artifacts");
          await mkdir(artifactsDir, { recursive: true });
          await writeFile(path.join(artifactsDir, "report.pdf"), "%PDF-1.4");
          return "created";
        },
      };

      const result = await executeProtectedTool(
        fileTool,
        {},
        {
          sessionId: "session_test",
          workspaceRoot,
        }
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toBeUndefined();
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
