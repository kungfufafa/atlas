import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ComparisonRun,
  startComparisonProxy,
} from "../harness-compare/proxy";
import type { HarnessTask } from "../harness-compare/types";

export interface ProductRequestUsage {
  cachedTokens: number | null;
  generatedTokens: number | null;
  index: number;
  kind: "pending" | "success" | "http-error" | "transport-error";
  promptTokens: number | null;
  status: number | null;
}

export interface ProductUsageEvidence {
  cachedTokens: number | null;
  finalized: boolean;
  generatedTokens: number | null;
  inFlightRequests: number;
  mandatoryUsageKnown: boolean;
  observationError: boolean;
  observedGeneratedTokens: number;
  observedPromptTokens: number;
  promptTokens: number | null;
  requests: ProductRequestUsage[];
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** One model-only listener per native trial; no shared tools or sibling routes. */
export async function startProductProxy(options: {
  directory: string;
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  harness: "atlas" | "hermes";
  keyFile: string;
  runId: string;
}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.runId)) {
    throw new Error("Product comparison run ID must be path-safe.");
  }
  const requests: ProductRequestUsage[] = [];
  const upstreamControllers = new Set<AbortController>();
  const forwards = new Set<Promise<unknown>>();
  let run: ComparisonRun | undefined;
  let finalized = false;
  let admissionClosed = false;
  let observationError = false;
  const usageEvidence = (): ProductUsageEvidence => {
    const observedGeneratedTokens = requests.reduce(
      (sum, request) => sum + (request.generatedTokens ?? 0),
      0
    );
    const observedPromptTokens = requests.reduce(
      (sum, request) => sum + (request.promptTokens ?? 0),
      0
    );
    const mandatoryUsageKnown =
      finalized &&
      !observationError &&
      upstreamControllers.size === 0 &&
      requests.length === run?.providerRequests &&
      requests.every(
        (request) =>
          request.kind === "success" &&
          request.generatedTokens !== null &&
          request.promptTokens !== null
      );
    return {
      cachedTokens:
        mandatoryUsageKnown &&
        requests.every((request) => request.cachedTokens !== null)
          ? requests.reduce((sum, request) => sum + request.cachedTokens!, 0)
          : null,
      finalized,
      generatedTokens: mandatoryUsageKnown ? observedGeneratedTokens : null,
      inFlightRequests: upstreamControllers.size,
      mandatoryUsageKnown,
      observationError,
      observedGeneratedTokens,
      observedPromptTokens,
      promptTokens: mandatoryUsageKnown ? observedPromptTokens : null,
      requests: structuredClone(requests),
    };
  };
  const broker = await startComparisonProxy(options.keyFile, {
    async fetchUpstream(url, init) {
      const controller = new AbortController();
      const record: ProductRequestUsage = {
        cachedTokens: null,
        generatedTokens: null,
        index: requests.length + 1,
        kind: "pending",
        promptTokens: null,
        status: null,
      };
      requests.push(record);
      upstreamControllers.add(controller);
      try {
        if (admissionClosed) {
          throw new Error("Native worker ended before upstream admission");
        }
        const response = await (options.fetchUpstream ?? fetch)(url, {
          ...init,
          signal: init.signal
            ? AbortSignal.any([init.signal, controller.signal])
            : controller.signal,
        });
        record.kind = response.ok ? "success" : "http-error";
        record.status = response.status;
        // The frozen broker retains the original raw response/status. Read only
        // a clone; errors remain errors even when they contain reported usage.
        let value: unknown;
        try {
          value = await response.clone().json();
        } catch {
          value = null;
        }
        const usage = object(object(value).usage);
        const details = object(usage.prompt_tokens_details);
        record.generatedTokens = count(usage.completion_tokens);
        record.promptTokens = count(usage.prompt_tokens);
        record.cachedTokens =
          count(details.cached_tokens) ?? count(usage.prompt_cache_hit_tokens);
        return response;
      } catch (error) {
        record.kind = "transport-error";
        throw error;
      } finally {
        upstreamControllers.delete(controller);
        try {
          await appendFile(
            join(options.directory, "native-usage-observations.jsonl"),
            `${JSON.stringify(record)}\n`
          );
        } catch {
          // Observation failure cannot mask an original provider response.
          observationError = true;
        }
      }
    },
  });
  try {
    // The reused accounting broker requires a fixture record. Native tools never
    // receive it, and the public listener exposes neither fixtures nor tools.
    const accountingTask: HarnessTask = {
      category: "corrections_and_supplied_memory",
      expected: { artifacts: [], finalFacts: {} },
      family: "portable_memory_application",
      id: options.runId,
      initialFiles: {},
      prompt: "",
      seed: 0,
      split: "development",
      turns: [],
    };
    run = await broker.register(
      options.runId,
      options.harness,
      accountingTask,
      options.directory
    );
    const modelPath = `/runs/${options.runId}/v1/models`;
    const chatPath = `/runs/${options.runId}/v1/chat/completions`;
    let pending: Promise<void> = Promise.resolve();
    let arrivals = 0;
    const handle = async (request: Request): Promise<Response> => {
      if (admissionClosed) {
        return Response.json(
          { error: { code: "native_run_closed" } },
          { status: 410 }
        );
      }
      const url = new URL(request.url);
      if (
        url.search ||
        !(
          (url.pathname === modelPath && request.method === "GET") ||
          (url.pathname === chatPath && request.method === "POST")
        )
      ) {
        return Response.json(
          { error: { code: "native_transport_only" } },
          { status: 404 }
        );
      }
      if (request.method === "GET") {
        return await fetch(`${broker.url}${url.pathname}`);
      }
      // Native title/review tasks may overlap foreground work. Serialize their
      // admission without dropping legitimate auxiliary requests or resetting
      // accounting. Queue time remains inside the same whole-trial budget.
      const arrivedAt = Date.now();
      const index = ++arrivals;
      const previous = pending;
      let release!: () => void;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        if (admissionClosed) {
          return Response.json(
            { error: { code: "native_run_closed" } },
            { status: 410 }
          );
        }
        request.signal.throwIfAborted();
        const body = await request.arrayBuffer();
        await appendFile(
          join(options.directory, "native-request-queue.jsonl"),
          `${JSON.stringify({ arrivedAt, index, queueWaitMs: Date.now() - arrivedAt })}\n`
        );
        request.signal.throwIfAborted();
        // Once admitted, a requester disconnect does not cancel the broker's
        // independent upstream generation. Keep this fetch and body drain alive
        // until its accounting settles; finalize owns cancellation at trial end.
        const response = await fetch(`${broker.url}${url.pathname}`, {
          body,
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        // Drain before releasing the slot, so response-body accounting in the
        // inner broker has also completed when the next request is admitted.
        return new Response(await response.arrayBuffer(), {
          headers: response.headers,
          status: response.status,
        });
      } finally {
        release();
      }
    };
    const listener = Bun.serve({
      fetch(request) {
        const forward = handle(request);
        const settled = forward.then(
          () => undefined,
          () => undefined
        );
        forwards.add(settled);
        settled.then(() => forwards.delete(settled));
        return forward;
      },
      hostname: "127.0.0.1",
      idleTimeout: 255,
      port: 0,
    });
    let finalization: Promise<ProductUsageEvidence> | undefined;
    const finalize = (): Promise<ProductUsageEvidence> => {
      finalization ??= (async () => {
        admissionClosed = true;
        // Called only after native workers exit. Any outstanding generation was
        // abandoned: cancel it and keep its mandatory usage unknown.
        for (const controller of upstreamControllers) {
          controller.abort(
            new Error("Native worker ended with upstream work pending")
          );
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const drained = await Promise.race([
          Promise.allSettled([...forwards]).then(() => true),
          new Promise<false>((resolve) => {
            timeout = setTimeout(() => resolve(false), 2000);
          }),
        ]);
        clearTimeout(timeout);
        observationError ||= !drained;
        await listener.stop(true);
        await broker.close();
        finalized = true;
        try {
          await writeFile(
            join(options.directory, "native-usage-final.json"),
            JSON.stringify(usageEvidence(), null, 2),
            { flag: "wx" }
          );
        } catch {
          observationError = true;
        }
        return usageEvidence();
      })();
      return finalization;
    };
    const publicOrigin = `http://127.0.0.1:${listener.port}`;
    try {
      await writeFile(
        join(options.directory, "native-transport-binding.json"),
        JSON.stringify(
          {
            chatPath,
            modelPath,
            publicOrigin,
            schemaVersion: 1,
            transportId: run.id,
          },
          null,
          2
        ),
        { flag: "wx", mode: 0o600 }
      );
    } catch (error) {
      await finalize();
      throw error;
    }
    return {
      async close() {
        await finalize();
      },
      finalize,
      run,
      url: publicOrigin,
      get usageEvidence() {
        return usageEvidence();
      },
    };
  } catch (error) {
    await broker.close();
    throw error;
  }
}
