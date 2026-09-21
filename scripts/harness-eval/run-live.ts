import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderClient } from "@atlas/core";
import { createOpenAICompatibleProvider } from "../../apps/server/src/providers/openai-compatible/index";
import { IncompleteCompletionError } from "../../packages/core/src/incomplete-completion";
import { redactSensitiveData } from "../../packages/core/src/secret-redaction";
import { parseHarnessEvalArgs } from "./flags";
import {
  LiveEvalEvidence,
  loadLiveEvalConfig,
  type ProviderFailure,
} from "./live-evidence";
import { runHarnessEval } from "./run";

export function redactEvaluationProviderErrors(
  provider: ProviderClient,
  apiKey: string,
  onFailure?: (
    operation: ProviderFailure["operation"],
    reason: ProviderFailure["reason"]
  ) => void
): ProviderClient {
  const protect = async <T>(
    operation: ProviderFailure["operation"],
    action: () => Promise<T>
  ): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      onFailure?.(
        operation,
        error instanceof IncompleteCompletionError
          ? "incomplete_completion"
          : "provider_error"
      );
      const sanitize = (value: string): string =>
        redactSensitiveData(value.replaceAll(apiKey, "[REDACTED]"));
      if (error instanceof IncompleteCompletionError) {
        // Preserve production's one-shot recovery and usage accounting, while
        // removing sensitive fragments and the original unsanitized cause.
        throw new IncompleteCompletionError(
          "Evaluation provider",
          {
            ...error.evidence,
            content: sanitize(error.evidence.content),
            thinking:
              error.evidence.thinking === undefined
                ? undefined
                : sanitize(error.evidence.thinking),
            toolInputFragments: error.evidence.toolInputFragments.map(
              (fragment) => ({
                arguments: sanitize(fragment.arguments),
                id:
                  fragment.id === undefined ? undefined : sanitize(fragment.id),
                name:
                  fragment.name === undefined
                    ? undefined
                    : sanitize(fragment.name),
              })
            ),
          },
          { recoveryAllowed: error.recoveryAllowed }
        );
      }
      const message =
        error instanceof Error ? error.message : "Evaluation provider failed";
      // Product auxiliary paths may log this error before a report is written.
      // Do not retain an unsanitized cause, headers or SDK error object.
      const safeError = new Error(sanitize(message));
      safeError.name = error instanceof Error ? sanitize(error.name) : "Error";
      throw safeError;
    }
  };
  return {
    ...provider,
    generateChat: (input) =>
      protect("generateChat", () => provider.generateChat(input)),
    generateText: (input) =>
      protect("generateText", () => provider.generateText(input)),
    streamChat: (input, handlers) =>
      protect("streamChat", () => provider.streamChat(input, handlers)),
  };
}

export function readEvaluationSourceState() {
  const root = realpathSync(resolve(import.meta.dir, "../.."));
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim().length > 0,
    root,
  };
}

export function liveRunPassed(
  report: Awaited<ReturnType<typeof runHarnessEval>> | undefined,
  run: ReturnType<LiveEvalEvidence["currentRun"]>
): boolean {
  return Boolean(
    report &&
      report.summary.failed === 0 &&
      report.scenarios.length > 0 &&
      run.rejectedDispatches.length === 0 &&
      run.providerFailures.length === 0 &&
      run.attempts.length > 0 &&
      run.attempts.every(
        (attempt) =>
          attempt.outcome === "response" &&
          attempt.status !== null &&
          attempt.status >= 200 &&
          attempt.status < 300
      )
  );
}

export async function runLiveEvaluation(
  argv = process.argv.slice(2)
): Promise<void> {
  const flags = parseHarnessEvalArgs(argv);
  if (flags.help) {
    process.stdout.write(
      "Live endpoint evaluation. Requires ATLAS_EVAL_API_KEY, ATLAS_EVAL_BASE_URL, ATLAS_EVAL_MODEL, ATLAS_EVAL_BUDGET_PATH. Optional ATLAS_EVAL_MAX_CALLS (1–300). Use --scenario <id> (repeatable), ablation flags and --out <report.json>. All runs in one cycle must share the same budget path.\n"
    );
    return;
  }
  if (flags.matrix || flags.promptOnly) {
    throw new Error(
      "Live endpoint evaluation requires real inference on one explicitly configured model."
    );
  }
  const config = loadLiveEvalConfig();
  if (flags.model && flags.model !== config.model) {
    throw new Error(
      "The CLI model must match the cycle model in ATLAS_EVAL_MODEL."
    );
  }
  const sourceBefore = readEvaluationSourceState();
  if (sourceBefore.dirty) {
    throw new Error(
      "Commit the evaluated source before live proof; keep credentials, ledger and output outside the checkout."
    );
  }
  const evidence = new LiveEvalEvidence(config);
  let report: Awaited<ReturnType<typeof runHarnessEval>> | undefined;
  let failure: string | undefined;
  try {
    const provider = redactEvaluationProviderErrors(
      createOpenAICompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        displayName: "Explicit evaluation endpoint",
        fetch: evidence.fetch,
        model: config.model,
        providerInstanceId: "live-harness-eval",
        supportsThinking: false,
      }),
      config.apiKey,
      (operation, reason) => evidence.recordProviderFailure(operation, reason)
    );
    report = await runHarnessEval({
      allowlist: flags.allowlist,
      archiveIndex: flags.archiveIndex,
      chatKind: flags.chatKind,
      ftsChats: flags.ftsChats,
      memoryRetrieval: flags.memoryRetrieval,
      memorySummarization: flags.memorySummarization,
      model: config.model,
      nativeSchemas: flags.nativeSchemas,
      provider,
      scenarioIds: flags.scenarioIds,
      skillLearning: flags.skillLearning,
      workRules: flags.workRules,
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : "Evaluation failed";
  }
  const snapshot = evidence.snapshot();
  const run = evidence.currentRun();
  evidence.close();
  const sourceAfter = readEvaluationSourceState();
  const sourceUnchanged =
    !sourceAfter.dirty && sourceBefore.commit === sourceAfter.commit;
  const passed = liveRunPassed(report, run) && sourceUnchanged;
  const output = {
    category: "live-harness-inference",
    evidence: snapshot,
    failure,
    limits:
      "Atlas harness with fixture tools; not AgentService, browser UX, cross-system parity or independently verified router backend identity.",
    passed,
    report,
    run,
    source: {
      after: sourceAfter,
      before: sourceBefore,
      unchanged: sourceUnchanged,
    },
  };
  const json = `${JSON.stringify(redactSensitiveData(output), null, 2).replaceAll(config.apiKey, "[REDACTED]")}\n`;
  if (flags.out) {
    await Bun.write(flags.out, json);
  }
  process.stdout.write(json);
  if (!passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runLiveEvaluation();
}
