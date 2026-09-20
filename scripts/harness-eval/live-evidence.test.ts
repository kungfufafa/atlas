import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatibleProvider } from "../../apps/server/src/providers/openai-compatible/index";
import { IncompleteCompletionError } from "../../packages/core/src/incomplete-completion";
import {
  type LiveEvalConfig,
  LiveEvalEvidence,
  loadLiveEvalConfig,
} from "./live-evidence";
import { runHarnessEval } from "./run";
import {
  liveRunPassed,
  readEvaluationSourceState,
  redactEvaluationProviderErrors,
} from "./run-live";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function config(maxCalls = 3): Promise<LiveEvalConfig> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-live-evidence-"));
  directories.push(directory);
  return {
    apiKey: "private-credential",
    baseUrl: "https://evaluation.example/v1",
    budgetPath: join(directory, "cycle.sqlite"),
    maxCalls,
    model: "fusion",
  };
}

function request(input: LiveEvalConfig) {
  return new Request(`${input.baseUrl}/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "secret fixture", role: "user" }],
      model: input.model,
    }),
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

test("source receipt follows evaluated Atlas checkout even when invoked elsewhere", async () => {
  const originalCwd = process.cwd();
  const expected = readEvaluationSourceState();
  const directory = await mkdtemp(join(tmpdir(), "atlas-eval-unrelated-cwd-"));
  directories.push(directory);
  try {
    process.chdir(directory);
    const actual = readEvaluationSourceState();
    expect(actual).toEqual(expected);
    expect(actual.root).not.toBe(directory);
  } finally {
    process.chdir(originalCwd);
  }
});

test("configuration requires explicit endpoint, model and durable cycle budget without historical credentials", () => {
  expect(() =>
    loadLiveEvalConfig({ OPENCODE_GO_API_KEY: "historical-secret" })
  ).toThrow();
  const env = {
    ATLAS_EVAL_API_KEY: "key",
    ATLAS_EVAL_BASE_URL: "https://router.rizqis.com/v1/",
    ATLAS_EVAL_BUDGET_PATH: "/tmp/cycle.sqlite",
    ATLAS_EVAL_MODEL: "fusion",
  };
  expect(loadLiveEvalConfig(env).baseUrl).toBe("https://router.rizqis.com/v1");
  expect(() =>
    loadLiveEvalConfig({ ...env, ATLAS_EVAL_MAX_CALLS: "301" })
  ).toThrow();
  expect(() =>
    loadLiveEvalConfig({ ...env, ATLAS_EVAL_BUDGET_PATH: ":memory:" })
  ).toThrow();
  expect(() =>
    loadLiveEvalConfig({ ...env, ATLAS_EVAL_BUDGET_PATH: "cycle.sqlite" })
  ).toThrow();
  expect(() =>
    loadLiveEvalConfig({
      ...env,
      ATLAS_EVAL_BASE_URL: "https://key@router.rizqis.com/v1",
    })
  ).toThrow();
});

test("failed transport and HTTP errors count across process-style reopen; next attempt is stopped before transport", async () => {
  const input = await config(2);
  let sent = 0;
  const first = new LiveEvalEvidence(input, async () => {
    sent++;
    throw new Error("transport failed");
  });
  await expect(first.fetch(request(input))).rejects.toThrow();
  first.close();
  const second = new LiveEvalEvidence(input, async () => {
    sent++;
    return new Response("unavailable", { status: 503 });
  });
  try {
    expect((await second.fetch(request(input))).status).toBe(503);
    await expect(second.fetch(request(input))).rejects.toThrow();
    expect(sent).toBe(2);
    expect(second.snapshot().used).toBe(2);
    expect(
      second.snapshot().attempts.map((attempt) => attempt.outcome)
    ).toEqual(["transport_error", "response"]);
  } finally {
    second.close();
  }
});

test("simultaneous clients share the cap and cannot change ledger identity or limit", async () => {
  const input = await config(1);
  let sent = 0;
  const transport = async () => {
    sent++;
    return Response.json({ model: "fusion" });
  };
  const first = new LiveEvalEvidence(input, transport);
  const second = new LiveEvalEvidence(input, transport);
  try {
    const results = await Promise.allSettled([
      first.fetch(request(input)),
      second.fetch(request(input)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(sent).toBe(1);
    expect(
      first.currentRun().attempts.length + second.currentRun().attempts.length
    ).toBe(1);
    expect(first.currentRun().runId).not.toBe(second.currentRun().runId);
    expect(
      first.currentRun().rejectedDispatches.length +
        second.currentRun().rejectedDispatches.length
    ).toBe(1);
    expect(
      () => new LiveEvalEvidence({ ...input, maxCalls: 2 }, transport)
    ).toThrow();
    expect(
      () => new LiveEvalEvidence({ ...input, model: "replacement" }, transport)
    ).toThrow();
  } finally {
    first.close();
    second.close();
  }
});

test("unexpected endpoint/model never dispatches; receipts contain no request text or credentials", async () => {
  const input = await config();
  let sent = 0;
  const evidence = new LiveEvalEvidence(input, async (_request, init) => {
    sent++;
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ model: "fusion" });
  });
  try {
    await expect(
      evidence.fetch("https://other.example/v1/chat/completions", {
        method: "POST",
      })
    ).rejects.toThrow();
    await expect(
      evidence.fetch(request({ ...input, model: "replacement" }))
    ).rejects.toThrow();
    expect(sent).toBe(0);
    await evidence.fetch(request(input));
    const snapshot = evidence.snapshot();
    expect(snapshot.backendIdentity).toBe("unverified");
    expect(snapshot.attempts[0]?.reportedModel).toBe("fusion");
    expect(JSON.stringify(snapshot)).not.toContain(input.apiKey);
  } finally {
    evidence.close();
  }
  const stored = await readFile(input.budgetPath, "utf8");
  expect(stored).not.toContain(input.apiKey);
  expect(stored).not.toContain("secret fixture");
});

test("a swallowed auxiliary failure cannot produce a passing live run or leak provider credentials", async () => {
  const input = await config(1);
  const logs: unknown[][] = [];
  const logger = spyOn(console, "error").mockImplementation((...args) => {
    logs.push(args);
  });
  const evidence = new LiveEvalEvidence(input, async () =>
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "I do not have a web_search tool assigned.",
            role: "assistant",
          },
        },
      ],
      model: "fusion",
    })
  );
  try {
    const provider = redactEvaluationProviderErrors(
      createOpenAICompatibleProvider({
        ...input,
        displayName: "Test endpoint",
        fetch: evidence.fetch,
        supportsThinking: false,
      }),
      input.apiKey
    );
    const report = await runHarnessEval({
      model: input.model,
      provider,
      scenarioIds: ["tool_avoid_absent_web_search"],
      skillLearning: true,
    });
    expect(evidence.snapshot().used).toBe(1);
    expect(evidence.currentRun().rejectedDispatches.length).toBeGreaterThan(0);
    expect(liveRunPassed(report, evidence.currentRun())).toBe(false);
    const unsafe = redactEvaluationProviderErrors(
      {
        ...provider,
        generateText: async () => {
          throw new Error(`rejected credential ${input.apiKey}`);
        },
      },
      input.apiKey
    );
    try {
      await unsafe.generateText({ format: "text", prompt: "review" });
    } catch (error) {
      console.error(error);
    }
    expect(
      logs.map((args) => args.map(String).join(" ")).join("\n")
    ).not.toContain(input.apiKey);
  } finally {
    logger.mockRestore();
    evidence.close();
  }
});

test("real adapter receives the explicit endpoint and exact model, with no OpenCode Go routing", async () => {
  const input = await config();
  const evidence = new LiveEvalEvidence(input, async (outbound) => {
    const actual = new Request(outbound);
    expect(actual.url).toBe(`${input.baseUrl}/chat/completions`);
    expect(actual.headers.get("x-opencode-session")).toBeNull();
    expect((await actual.json()).model).toBe("fusion");
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "ready", role: "assistant" },
        },
      ],
      model: "fusion",
    });
  });
  try {
    const provider = createOpenAICompatibleProvider({
      ...input,
      displayName: "Test endpoint",
      fetch: evidence.fetch,
      supportsThinking: false,
    });
    const report = await runHarnessEval({
      model: input.model,
      provider,
      scenarioIds: ["session_transport"],
    });
    expect(report.summary.passed).toBe(1);
    expect(evidence.snapshot().used).toBe(1);
    await expect(
      runHarnessEval({
        model: input.model,
        provider,
        scenarioIds: ["nonexistent-scenario"],
      })
    ).rejects.toThrow();
    expect(evidence.snapshot().used).toBe(1);
  } finally {
    evidence.close();
  }
});

test("a malformed HTTP 200 auxiliary response cannot pass when its adapter error is swallowed", async () => {
  const input = await config();
  let calls = 0;
  const logs: unknown[][] = [];
  const logger = spyOn(console, "error").mockImplementation((...args) => {
    logs.push(args);
  });
  const evidence = new LiveEvalEvidence(input, async () => {
    calls++;
    return calls === 1
      ? Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "I do not have a web_search tool assigned.",
                role: "assistant",
              },
            },
          ],
          model: input.model,
        })
      : Response.json({ choices: [], model: input.model });
  });
  try {
    const provider = redactEvaluationProviderErrors(
      createOpenAICompatibleProvider({
        ...input,
        displayName: "Test endpoint",
        fetch: evidence.fetch,
        supportsThinking: false,
      }),
      input.apiKey,
      (operation, reason) => evidence.recordProviderFailure(operation, reason)
    );
    const report = await runHarnessEval({
      model: input.model,
      provider,
      scenarioIds: ["tool_avoid_absent_web_search"],
      skillLearning: true,
    });
    const run = evidence.currentRun();
    expect(report.summary.failed).toBe(0);
    expect(calls).toBe(2);
    expect(run.attempts.map((attempt) => attempt.status)).toEqual([200, 200]);
    expect(run.rejectedDispatches).toHaveLength(0);
    expect(run.providerFailures).toEqual([
      {
        operation: "generateText",
        reason: "provider_error",
        runId: evidence.runId,
      },
    ]);
    expect(logs.length).toBeGreaterThan(0);
    expect(liveRunPassed(report, run)).toBe(false);
    const reopened = new LiveEvalEvidence(input);
    try {
      expect(reopened.snapshot().providerFailures).toEqual(
        run.providerFailures
      );
      expect(reopened.currentRun().providerFailures).toHaveLength(0);
    } finally {
      reopened.close();
    }
  } finally {
    logger.mockRestore();
    evidence.close();
  }
});

test("redaction preserves output-limit recovery, diagnostic usage and recovery refusal", async () => {
  const input = await config();
  let sent = 0;
  const evidence = new LiveEvalEvidence(input, async () => {
    sent++;
    return Response.json({
      choices: [
        {
          finish_reason: sent === 1 ? "length" : "stop",
          message: {
            content: sent === 1 ? `fragment ${input.apiKey}` : "ready",
            role: "assistant",
          },
        },
      ],
      model: input.model,
      usage: { completion_tokens: 5, prompt_tokens: 10 },
    });
  });
  try {
    const provider = redactEvaluationProviderErrors(
      createOpenAICompatibleProvider({
        ...input,
        displayName: "Test endpoint",
        fetch: evidence.fetch,
        supportsThinking: false,
      }),
      input.apiKey,
      (operation, reason) => evidence.recordProviderFailure(operation, reason)
    );
    const report = await runHarnessEval({
      model: input.model,
      provider,
      scenarioIds: ["session_transport"],
    });
    expect(report.summary.failed).toBe(0);
    expect(evidence.snapshot().used).toBe(2);
    expect(evidence.currentRun().providerFailures).toEqual([
      {
        operation: "generateChat",
        reason: "incomplete_completion",
        runId: evidence.runId,
      },
    ]);
    expect(liveRunPassed(report, evidence.currentRun())).toBe(false);
    const noRecovery = redactEvaluationProviderErrors(
      {
        ...provider,
        generateChat: async () => {
          throw new IncompleteCompletionError(
            "test",
            {
              content: input.apiKey,
              toolInputFragments: [],
              usage: { inputTokens: 10, outputTokens: 5 },
            },
            { recoveryAllowed: false }
          );
        },
      },
      input.apiKey
    );
    try {
      await noRecovery.generateChat({ messages: [], system: "" });
      throw new Error("Expected output-limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteCompletionError);
      if (error instanceof IncompleteCompletionError) {
        expect(error.recoveryAllowed).toBe(false);
        expect(error.evidence.usage?.inputTokens).toBe(10);
        expect(error.evidence.content).not.toContain(input.apiKey);
      }
    }
  } finally {
    evidence.close();
  }
});
