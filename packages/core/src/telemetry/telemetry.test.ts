import { describe, expect, it } from "bun:test";
import {
  AtlasMetricsRegistry,
  BoundedCache,
  CircuitBreaker,
  classifyFailure,
  createTraceContext,
  DEFAULT_EXECUTION_BUDGET,
  ExecutionCostTracker,
  ExecutionSummaryBuilder,
  evaluateSlo,
  FanoutGuard,
  generateSafeDebugBundle,
  runWithTraceContext,
  withSpan,
} from "../index";

describe("Telemetry & Resilience Core Suite", () => {
  it("propagates canonical trace context and spans", async () => {
    const rootContext = createTraceContext({
      conversationId: "conv_123",
      orgId: "org_abc",
      userId: "usr_456",
    });

    expect(rootContext.traceId.startsWith("trc_")).toBe(true);
    expect(rootContext.executionAttemptId.startsWith("exec_")).toBe(true);

    const result = await runWithTraceContext(rootContext, async () =>
      withSpan("test_operation", async (span) => {
        expect(span.name).toBe("test_operation");
        expect(span.traceId).toBe(rootContext.traceId);
        expect(span.executionAttemptId).toBe(rootContext.executionAttemptId);
        return 42;
      })
    );

    expect(result).toBe(42);
  });

  it("classifies failures into normalized failure taxonomy", () => {
    expect(classifyFailure(new Error("Rate limit exceeded 429")).code).toBe(
      "PROVIDER_RATE_LIMIT"
    );
    expect(classifyFailure(new Error("Request timed out after 30s")).code).toBe(
      "PROVIDER_TIMEOUT"
    );
    expect(classifyFailure(new Error("HTTP 502 Bad Gateway")).code).toBe(
      "PROVIDER_5XX"
    );
    expect(classifyFailure(new Error("Turn cancelled by user")).code).toBe(
      "CANCELLED"
    );
    expect(classifyFailure(new Error("Browser navigation crashed")).code).toBe(
      "BROWSER_NAVIGATION_FAILED"
    );
    expect(
      classifyFailure(new Error("Execution budget exceeded max tokens")).code
    ).toBe("EXECUTION_BUDGET_EXCEEDED");
  });

  it("records metrics, calculates percentiles and outputs Prometheus format", () => {
    const reg = new AtlasMetricsRegistry();
    reg.executionTotal.inc({ policy: "standard" }, 1);
    reg.executionSuccessTotal.inc({ policy: "standard" }, 1);
    reg.executionDurationMs.observe(100, { policy: "standard" });
    reg.executionDurationMs.observe(200, { policy: "standard" });
    reg.executionDurationMs.observe(500, { policy: "standard" });

    const p = reg.executionDurationMs.getPercentiles({ policy: "standard" });
    expect(p.count).toBe(3);
    expect(p.p50).toBe(200);
    expect(p.p95).toBe(500);

    const prom = reg.toPrometheus();
    expect(prom).toContain("atlas_execution_total");
    expect(prom).toContain("atlas_execution_duration_ms");
  });

  it("tracks execution costs and enforces budget guardrails", () => {
    const tracker = new ExecutionCostTracker(
      "exec_test",
      "conv_test",
      "org_test",
      "usr_test",
      {
        ...DEFAULT_EXECUTION_BUDGET,
        maxTokens: 1000,
      }
    );

    const r1 = tracker.recordModelTurn("gpt-4o", 200, 300);
    expect(r1.exceededBudget).toBe(false);

    const summary1 = tracker.getSummary();
    expect(summary1.rawUnits.inputTokens).toBe(200);
    expect(summary1.rawUnits.outputTokens).toBe(300);
    expect(summary1.totalCostUsd).toBeGreaterThan(0);

    const r2 = tracker.recordModelTurn("gpt-4o", 400, 500);
    expect(r2.exceededBudget).toBe(true);
    expect(r2.reason).toContain("token budget");
  });

  it("builds end-to-end execution summary and safe debug bundle without secrets", () => {
    const builder = new ExecutionSummaryBuilder(
      "exec_test_bundle",
      "conv_test",
      "org_test",
      "usr_test"
    );
    builder.recordEvent("tool.started", "Tool started", { tool: "web_search" });
    builder.recordEvent("tool.completed", "Tool completed", {
      apiKey: "secret_api_key_12345",
      password: "supersecretpassword",
      results: "clean result data",
    });

    const costSummary = new ExecutionCostTracker(
      "exec_test_bundle"
    ).getSummary();
    const summary = builder.build(costSummary);
    expect(summary.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(summary.toolCallsCount).toBe(1);

    const debugBundle = generateSafeDebugBundle(summary);
    expect(debugBundle.executionId).toBe("exec_test_bundle");
    const toolEvent = debugBundle.timeline.find(
      (e) => e.type === "tool.completed"
    );
    expect(toolEvent?.data?.apiKey).toBe("[REDACTED]");
    expect(toolEvent?.data?.password).toBe("[REDACTED]");
    expect(toolEvent?.data?.results).toBe("clean result data");
  });

  it("evaluates SLO targets and error budget burn rate", () => {
    const slo = {
      id: "test_slo",
      name: "Test SLO",
      targetPercent: 99.0,
      windowDays: 30,
    };

    const healthy = evaluateSlo(slo, 1000, 5); // 0.5% failure < 1% allowed
    expect(healthy.status).toBe("healthy");
    expect(healthy.actualAvailabilityPercent).toBe(99.5);
    expect(healthy.errorBudgetRemaining).toBeGreaterThan(0);

    const exhausted = evaluateSlo(slo, 1000, 20); // 2.0% failure > 1% allowed
    expect(exhausted.status).toBe("exhausted");
    expect(exhausted.actualAvailabilityPercent).toBe(98.0);
  });

  it("executes circuit breaker state transitions (closed -> open -> half-open -> closed)", async () => {
    const cb = new CircuitBreaker("test_service", {
      failureThreshold: 2,
      halfOpenSuccessThreshold: 1,
      resetTimeoutMs: 50,
    });

    expect(cb.getState()).toBe("CLOSED");

    // Fail 1
    await expect(
      cb.execute(async () => {
        throw new Error("fail 1");
      })
    ).rejects.toThrow("fail 1");
    expect(cb.getState()).toBe("CLOSED");

    // Fail 2 -> Trips to OPEN
    await expect(
      cb.execute(async () => {
        throw new Error("fail 2");
      })
    ).rejects.toThrow("fail 2");
    expect(cb.getState()).toBe("OPEN");

    // Immediate attempt is blocked
    await expect(cb.execute(async () => 123)).rejects.toThrow(
      "Circuit breaker [test_service] is OPEN"
    );

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe("HALF_OPEN");

    // Success in half-open resets to CLOSED
    const res = await cb.execute(async () => 999);
    expect(res).toBe(999);
    expect(cb.getState()).toBe("CLOSED");
  });

  it("enforces bounded cache size and TTL eviction", async () => {
    const cache = new BoundedCache<string, number>({
      maxEntries: 2,
      ttlMs: 50,
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts 'a'

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);

    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get("b")).toBeUndefined(); // expired
    expect(cache.get("c")).toBeUndefined(); // expired
  });

  it("guards against runaway subagent recursion and research fanout", () => {
    const guard = new FanoutGuard({
      maxResearchQueriesPerSession: 2,
      maxSubAgentDepth: 2,
      maxSubAgentsPerExecution: 3,
    });

    expect(guard.canSpawnSubAgent(1).allowed).toBe(true);
    guard.recordSubAgentSpawned();
    expect(guard.canSpawnSubAgent(2).allowed).toBe(true);
    guard.recordSubAgentSpawned();
    expect(guard.canSpawnSubAgent(3).allowed).toBe(false); // Depth 3 exceeds 2

    expect(guard.canExecuteResearchQuery().allowed).toBe(true);
    guard.recordResearchQuery();
    expect(guard.canExecuteResearchQuery().allowed).toBe(true);
    guard.recordResearchQuery();
    expect(guard.canExecuteResearchQuery().allowed).toBe(false); // Reached 2
  });
});
