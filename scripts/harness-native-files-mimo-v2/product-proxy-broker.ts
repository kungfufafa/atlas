import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  executeSharedTool,
  initializeFiles,
  snapshotFiles,
  toolSchemas,
} from "../harness-compare/tools";
import type { HarnessTask, HarnessToolEvent } from "../harness-compare/types";

export const comparisonLimits = {
  generatedTokens: 12_000,
  perResponseTokens: 4096,
  providerRequests: 24,
  timeoutMs: 300_000,
} as const;
export const comparisonModel = "mimo-v2.5";
export const upstreamEndpoint = "https://opencode.ai/zen/go/v1";

export interface ComparisonRun {
  activeRequest: boolean;
  budgetExceeded: boolean;
  cachedTokens: number;
  directory: string;
  generatedTokens: number;
  harness: "atlas" | "hermes";
  id: string;
  missingUsage: boolean;
  promptTokens: number;
  providerRequests: number;
  providerStatuses: number[];
  startedAt: number;
  task: HarnessTask;
  toolEvents: HarnessToolEvent[];
  workspace: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function failure(message: string, code: string, status = 400): Response {
  return Response.json(
    { error: { code, message, type: "comparison_error" } },
    { status }
  );
}

export async function startComparisonProxy(
  keyFile: string,
  options: {
    fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  } = {}
) {
  const key = (await readFile(keyFile, "utf8")).trim();
  if (!key) {
    throw new Error("Missing comparison credential.");
  }
  const runs = new Map<string, ComparisonRun>();
  const clean = (value: string) => value.replaceAll(key, "[REDACTED]");

  const forward = async (
    run: ComparisonRun,
    request: Request
  ): Promise<Response> => {
    const elapsed = Date.now() - run.startedAt;
    if (
      run.budgetExceeded ||
      run.providerRequests >= comparisonLimits.providerRequests ||
      run.generatedTokens >= comparisonLimits.generatedTokens ||
      elapsed >= comparisonLimits.timeoutMs ||
      run.missingUsage
    ) {
      run.budgetExceeded = true;
      await appendFile(
        join(run.directory, "budget-rejections.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), elapsed, generatedTokens: run.generatedTokens, missingUsage: run.missingUsage, requests: run.providerRequests })}\n`
      );
      return failure(
        "This comparison trial has exhausted its declared budget.",
        "trial_budget_exhausted"
      );
    }
    if (run.activeRequest) {
      return failure(
        "Concurrent inference in one trial is disabled in this track.",
        "concurrent_inference"
      );
    }
    const requested = object(await request.json());
    if (run.activeRequest) {
      return failure(
        "Concurrent inference in one trial is disabled in this track.",
        "concurrent_inference"
      );
    }
    if (requested.model !== comparisonModel) {
      return failure(
        "Only the preregistered exact model is available.",
        "model_mismatch"
      );
    }
    if (requested.stream) {
      return failure(
        "This preregistered track uses nonstreaming inference.",
        "streaming_not_in_track"
      );
    }
    run.activeRequest = true;
    const index = String(++run.providerRequests).padStart(3, "0");
    const startedAt = Date.now();
    // Normalize only preregistered generation controls, retaining each harness's messages and schemas.
    const effective: Record<string, unknown> = {
      ...requested,
      max_tokens: Math.min(
        comparisonLimits.perResponseTokens,
        comparisonLimits.generatedTokens - run.generatedTokens
      ),
      model: comparisonModel,
      stream: false,
      temperature: 0.2,
    };
    delete effective.max_completion_tokens;
    delete effective.stream_options;
    delete effective.reasoning_effort;
    delete effective.thinking;
    const metadata = {
      at: new Date().toISOString(),
      effective,
      model: comparisonModel,
      request: requested,
      upstreamEndpoint,
    };
    await writeFile(
      join(run.directory, `${index}-request.json`),
      clean(JSON.stringify(metadata, null, 2)),
      { flag: "wx" }
    );
    try {
      const upstream = await (options.fetchUpstream ?? fetch)(
        `${upstreamEndpoint}/chat/completions`,
        {
          body: JSON.stringify(effective),
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "user-agent": "Atlas-Hermes-Compatibility-Probe/1.0 (nonstreaming)",
            "x-opencode-session": run.id,
          },
          method: "POST",
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(90_000, comparisonLimits.timeoutMs - elapsed))
          ),
        }
      );
      const raw = clean(await upstream.text());
      run.providerStatuses.push(upstream.status);
      let response: Record<string, unknown> | null = null;
      try {
        response = object(JSON.parse(raw));
      } catch {
        /* Raw non-JSON errors remain evidence. */
      }
      if (upstream.ok) {
        const usage =
          response?.usage &&
          typeof response.usage === "object" &&
          !Array.isArray(response.usage)
            ? object(response.usage)
            : {};
        const completion = count(usage.completion_tokens);
        const prompt = count(usage.prompt_tokens);
        if (completion === null || prompt === null) {
          run.missingUsage = true;
        }
        run.generatedTokens += completion ?? 0;
        run.promptTokens += prompt ?? 0;
        const details =
          usage.prompt_tokens_details &&
          typeof usage.prompt_tokens_details === "object" &&
          !Array.isArray(usage.prompt_tokens_details)
            ? object(usage.prompt_tokens_details)
            : {};
        run.cachedTokens +=
          count(details.cached_tokens) ??
          count(usage.prompt_cache_hit_tokens) ??
          0;
        if (
          run.missingUsage ||
          (completion ?? 0) >
            (count(effective.max_tokens) ??
              comparisonLimits.perResponseTokens) ||
          run.generatedTokens > comparisonLimits.generatedTokens ||
          Date.now() - run.startedAt > comparisonLimits.timeoutMs
        ) {
          run.budgetExceeded = true;
        }
      }
      await writeFile(
        join(run.directory, `${index}-response.json`),
        clean(
          JSON.stringify(
            {
              at: new Date().toISOString(),
              elapsedMs: Date.now() - startedAt,
              headers: {
                "content-type": upstream.headers.get("content-type"),
                "retry-after": upstream.headers.get("retry-after"),
              },
              response: response ?? raw,
              status: upstream.status,
            },
            null,
            2
          )
        ),
        { flag: "wx" }
      );
      const headers: Record<string, string> = {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      };
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) {
        headers["retry-after"] = retryAfter;
      }
      return new Response(raw, { headers, status: upstream.status });
    } catch (error) {
      const message = clean(
        error instanceof Error ? error.message : String(error)
      );
      await writeFile(
        join(run.directory, `${index}-transport-error.json`),
        JSON.stringify({
          at: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          message,
        }),
        { flag: "wx" }
      );
      run.providerStatuses.push(502);
      return failure(message, "upstream_transport_error", 502);
    } finally {
      run.activeRequest = false;
    }
  };

  const server = Bun.serve({
    async fetch(request) {
      try {
        const url = new URL(request.url);
        const segments = url.pathname.split("/").filter(Boolean);
        if (url.pathname === "/tool-schemas") {
          return Response.json(toolSchemas);
        }
        const run =
          segments[0] === "runs" ? runs.get(segments[1] ?? "") : undefined;
        if (!run) {
          return failure("Unknown comparison run.", "unknown_run", 404);
        }
        if (segments[2] === "tool-schemas") {
          return Response.json(toolSchemas);
        }
        if (segments[2] === "v1" && segments[3] === "models") {
          return Response.json({
            data: [
              { id: comparisonModel, object: "model", owned_by: "opencode" },
            ],
            object: "list",
          });
        }
        if (
          segments[2] === "v1" &&
          segments[3] === "chat" &&
          segments[4] === "completions" &&
          request.method === "POST"
        ) {
          return await forward(run, request);
        }
        if (segments[2] === "tools" && request.method === "POST") {
          const event = await executeSharedTool(
            run.workspace,
            run.task,
            segments[3] ?? "",
            object(await request.json())
          );
          run.toolEvents.push(event);
          await appendFile(
            join(run.directory, "tool-events.jsonl"),
            `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
          );
          return Response.json(event.result);
        }
        return failure(
          "Unsupported comparison endpoint.",
          "unknown_endpoint",
          404
        );
      } catch (error) {
        return failure(
          clean(error instanceof Error ? error.message : String(error)),
          "proxy_error",
          500
        );
      }
    },
    hostname: "127.0.0.1",
    idleTimeout: 255,
    port: 0,
  });

  return {
    async close() {
      await server.stop(true);
    },
    async register(
      id: string,
      harness: ComparisonRun["harness"],
      task: HarnessTask,
      directory: string
    ): Promise<ComparisonRun> {
      if (runs.has(id)) {
        throw new Error("Comparison run IDs cannot be reused.");
      }
      await mkdir(directory, { recursive: true });
      const workspace = join(directory, "workspace");
      await initializeFiles(workspace, task.initialFiles);
      const run: ComparisonRun = {
        activeRequest: false,
        budgetExceeded: false,
        cachedTokens: 0,
        directory,
        generatedTokens: 0,
        harness,
        id,
        missingUsage: false,
        promptTokens: 0,
        providerRequests: 0,
        providerStatuses: [],
        startedAt: Date.now(),
        task,
        toolEvents: [],
        workspace,
      };
      runs.set(id, run);
      return run;
    },
    async snapshot(run: ComparisonRun) {
      return await snapshotFiles(run.workspace);
    },
    url: `http://127.0.0.1:${server.port}`,
  };
}
