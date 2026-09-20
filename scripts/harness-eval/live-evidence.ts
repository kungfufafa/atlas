import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fetchWithoutIdleTimeout } from "../../packages/core/src/fetch-idle";

export const LIVE_EVAL_MAX_CALLS = 300;
const TRAILING_SLASHES = /\/+$/;

export interface LiveEvalConfig {
  apiKey: string;
  baseUrl: string;
  budgetPath: string;
  maxCalls: number;
  model: string;
}

export function loadLiveEvalConfig(
  env: NodeJS.ProcessEnv = process.env
): LiveEvalConfig {
  const apiKey = env.ATLAS_EVAL_API_KEY?.trim();
  const baseUrl = env.ATLAS_EVAL_BASE_URL?.trim().replace(TRAILING_SLASHES, "");
  const model = env.ATLAS_EVAL_MODEL?.trim();
  const budgetPath = env.ATLAS_EVAL_BUDGET_PATH?.trim();
  const maxCalls = Number(env.ATLAS_EVAL_MAX_CALLS ?? LIVE_EVAL_MAX_CALLS);
  if (!(apiKey && baseUrl && model && budgetPath && isAbsolute(budgetPath))) {
    throw new Error(
      "Live eval requires ATLAS_EVAL_API_KEY, ATLAS_EVAL_BASE_URL, ATLAS_EVAL_MODEL and a persistent ATLAS_EVAL_BUDGET_PATH."
    );
  }
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Live eval requires an HTTPS endpoint without embedded credentials, query or fragment."
    );
  }
  if (
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > LIVE_EVAL_MAX_CALLS
  ) {
    throw new Error(
      "Live eval limit must be between 1 and 300 inference attempts per cycle."
    );
  }
  return { apiKey, baseUrl, budgetPath, maxCalls, model };
}

export interface AttemptReceipt {
  id: number;
  outcome: "reserved" | "response" | "transport_error";
  reportedModel: string | null;
  requestedAt: string;
  runId: string;
  status: number | null;
}

interface RejectedDispatch {
  reason:
    | "budget_exhausted"
    | "unexpected_endpoint"
    | "unexpected_model"
    | "invalid_request";
  runId: string;
}

export interface ProviderFailure {
  operation: "generateChat" | "generateText" | "streamChat";
  reason: "incomplete_completion" | "provider_error";
  runId: string;
}

/** One private ledger per cycle, shared across baseline/candidate runs and processes.
 * Reservations commit before transport. Crashed/incomplete attempts still count.
 * This counts client HTTP attempts, not hidden router-internal model requests.
 */
export class LiveEvalEvidence {
  private readonly database: Database;
  readonly fetch: typeof fetchWithoutIdleTimeout;
  readonly runId = randomUUID();

  constructor(
    private readonly config: LiveEvalConfig,
    transport: typeof fetchWithoutIdleTimeout = fetchWithoutIdleTimeout
  ) {
    loadLiveEvalConfig({
      ATLAS_EVAL_API_KEY: config.apiKey,
      ATLAS_EVAL_BASE_URL: config.baseUrl,
      ATLAS_EVAL_BUDGET_PATH: config.budgetPath,
      ATLAS_EVAL_MAX_CALLS: String(config.maxCalls),
      ATLAS_EVAL_MODEL: config.model,
    });
    this.database = new Database(config.budgetPath, { create: true });
    chmodSync(config.budgetPath, 0o600);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), base_url TEXT NOT NULL, model TEXT NOT NULL, max_calls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, requested_at TEXT NOT NULL, reported_model TEXT, outcome TEXT NOT NULL, status INTEGER);
      CREATE TABLE IF NOT EXISTS rejected_dispatches (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_failures (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, operation TEXT NOT NULL, reason TEXT NOT NULL);
    `);
    try {
      this.database
        .transaction(() => {
          this.database
            .query("INSERT OR IGNORE INTO config VALUES (1, ?, ?, ?)")
            .run(config.baseUrl, config.model, config.maxCalls);
          const saved = this.database
            .query<{ base_url: string; model: string; max_calls: number }, []>(
              "SELECT * FROM config WHERE id = 1"
            )
            .get();
          if (
            saved?.base_url !== config.baseUrl ||
            saved.model !== config.model ||
            saved.max_calls !== config.maxCalls
          ) {
            throw new Error(
              "An existing cycle ledger cannot change endpoint, model or limit."
            );
          }
        })
        .immediate();
    } catch (error) {
      this.database.close();
      throw error;
    }
    this.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method !== "POST" ||
        request.url !== `${config.baseUrl}/chat/completions`
      ) {
        return this.reject("unexpected_endpoint");
      }
      let body: unknown;
      try {
        body = await request.clone().json();
      } catch {
        return this.reject("invalid_request");
      }
      if (
        !body ||
        typeof body !== "object" ||
        !("model" in body) ||
        body.model !== config.model
      ) {
        return this.reject("unexpected_model");
      }
      const id = this.reserve();
      try {
        // Redirects must not forward the credential or escape measured transport.
        const response = await transport(request, {
          redirect: "error",
          signal: request.signal,
        });
        let reportedModel: string | null = null;
        if (
          response.headers.get("content-type")?.includes("application/json")
        ) {
          try {
            const payload: unknown = await response.clone().json();
            if (
              payload &&
              typeof payload === "object" &&
              "model" in payload &&
              typeof payload.model === "string"
            ) {
              reportedModel = payload.model
                .replaceAll(config.apiKey, "[REDACTED]")
                .slice(0, 256);
            }
          } catch {
            // Malformed bodies remain available to the adapter as failures.
          }
        }
        this.database
          .query(
            "UPDATE attempts SET outcome = 'response', status = ?, reported_model = ? WHERE id = ?"
          )
          .run(response.status, reportedModel, id);
        return response;
      } catch (error) {
        this.database
          .query("UPDATE attempts SET outcome = 'transport_error' WHERE id = ?")
          .run(id);
        throw error;
      }
    };
  }

  private reserve(): number {
    const id = this.database
      .transaction(() => {
        const count =
          this.database
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM attempts"
            )
            .get()?.count ?? 0;
        if (count >= this.config.maxCalls) {
          return null;
        }
        return Number(
          this.database
            .query(
              "INSERT INTO attempts(run_id, requested_at, outcome) VALUES (?, ?, 'reserved')"
            )
            .run(this.runId, new Date().toISOString()).lastInsertRowid
        );
      })
      .immediate();
    if (id === null) {
      return this.reject("budget_exhausted");
    }
    return id;
  }

  private reject(reason: RejectedDispatch["reason"]): never {
    // Some auxiliary model errors are deliberately swallowed by the product.
    // A rejected dispatch must still prevent the evaluation from going green.
    this.database
      .query("INSERT INTO rejected_dispatches(run_id, reason) VALUES (?, ?)")
      .run(this.runId, reason);
    throw new Error(
      `Evaluation dispatch blocked: ${reason}. No request was sent.`
    );
  }

  recordProviderFailure(
    operation: ProviderFailure["operation"],
    reason: ProviderFailure["reason"]
  ): void {
    // HTTP success is insufficient: an adapter may reject a malformed payload,
    // and optional product paths may swallow that error. Store no error text.
    this.database
      .query(
        "INSERT INTO provider_failures(run_id, operation, reason) VALUES (?, ?, ?)"
      )
      .run(this.runId, operation, reason);
  }

  snapshot() {
    const attempts = this.database
      .query<AttemptReceipt, []>(
        "SELECT id, run_id AS runId, requested_at AS requestedAt, reported_model AS reportedModel, outcome, status FROM attempts ORDER BY id"
      )
      .all();
    const rejectedDispatches = this.database
      .query<RejectedDispatch, []>(
        "SELECT run_id AS runId, reason FROM rejected_dispatches ORDER BY id"
      )
      .all();
    const providerFailures = this.database
      .query<ProviderFailure, []>(
        "SELECT run_id AS runId, operation, reason FROM provider_failures ORDER BY id"
      )
      .all();
    return {
      attempts,
      backendIdentity: "unverified" as const,
      baseUrl: this.config.baseUrl,
      limit: this.config.maxCalls,
      model: this.config.model,
      providerFailures,
      rejectedDispatches,
      remaining: this.config.maxCalls - attempts.length,
      used: attempts.length,
    };
  }

  currentRun() {
    const snapshot = this.snapshot();
    return {
      attempts: snapshot.attempts.filter(
        (attempt) => attempt.runId === this.runId
      ),
      providerFailures: snapshot.providerFailures.filter(
        (failure) => failure.runId === this.runId
      ),
      rejectedDispatches: snapshot.rejectedDispatches.filter(
        (attempt) => attempt.runId === this.runId
      ),
      runId: this.runId,
    };
  }

  close(): void {
    this.database.close();
  }
}
