export interface MetricLabels {
  [key: string]: string | undefined;
}

export interface MetricSummary {
  help: string;
  name: string;
  type: "counter" | "gauge" | "histogram";
  values: Array<{
    labels: Record<string, string>;
    value: number;
    count?: number;
    sum?: number;
    p50?: number;
    p90?: number;
    p95?: number;
    p99?: number;
  }>;
}

export class Counter {
  private values = new Map<
    string,
    { labels: Record<string, string>; value: number }
  >();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {}

  private key(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
  }

  inc(labels: Record<string, string> = {}, amount = 1): void {
    const k = this.key(labels);
    const existing = this.values.get(k);
    if (existing) {
      existing.value += amount;
    } else {
      this.values.set(k, { labels, value: amount });
    }
  }

  get(labels: Record<string, string> = {}): number {
    return this.values.get(this.key(labels))?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  collect(): MetricSummary {
    return {
      help: this.help,
      name: this.name,
      type: "counter",
      values: Array.from(this.values.values()),
    };
  }
}

export class Gauge {
  private values = new Map<
    string,
    { labels: Record<string, string>; value: number }
  >();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {}

  private key(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
  }

  set(value: number, labels: Record<string, string> = {}): void {
    this.values.set(this.key(labels), { labels, value });
  }

  inc(labels: Record<string, string> = {}, amount = 1): void {
    const k = this.key(labels);
    const existing = this.values.get(k);
    if (existing) {
      existing.value += amount;
    } else {
      this.values.set(k, { labels, value: amount });
    }
  }

  dec(labels: Record<string, string> = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  get(labels: Record<string, string> = {}): number {
    return this.values.get(this.key(labels))?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  collect(): MetricSummary {
    return {
      help: this.help,
      name: this.name,
      type: "gauge",
      values: Array.from(this.values.values()),
    };
  }
}

export class Histogram {
  private samples = new Map<
    string,
    { labels: Record<string, string>; values: number[]; sum: number }
  >();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {}

  private key(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
  }

  observe(value: number, labels: Record<string, string> = {}): void {
    const k = this.key(labels);
    let entry = this.samples.get(k);
    if (!entry) {
      entry = { labels, sum: 0, values: [] };
      this.samples.set(k, entry);
    }
    entry.values.push(value);
    entry.sum += value;
    // Cap in-memory samples per label set to prevent memory pressure
    if (entry.values.length > 5000) {
      entry.values.splice(0, 1000);
    }
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
      return 0;
    }
    const index = Math.min(
      Math.floor((p / 100) * sorted.length),
      sorted.length - 1
    );
    return sorted[index] ?? 0;
  }

  getPercentiles(labels: Record<string, string> = {}): {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    count: number;
    sum: number;
    avg: number;
  } {
    const entry = this.samples.get(this.key(labels));
    if (!entry || entry.values.length === 0) {
      return { avg: 0, count: 0, p50: 0, p90: 0, p95: 0, p99: 0, sum: 0 };
    }

    const sorted = [...entry.values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = entry.sum;
    return {
      avg: sum / count,
      count,
      p50: this.percentile(sorted, 50),
      p90: this.percentile(sorted, 90),
      p95: this.percentile(sorted, 95),
      p99: this.percentile(sorted, 99),
      sum,
    };
  }

  reset(): void {
    this.samples.clear();
  }

  collect(): MetricSummary {
    const values: MetricSummary["values"] = [];
    for (const entry of this.samples.values()) {
      const sorted = [...entry.values].sort((a, b) => a - b);
      const count = sorted.length;
      values.push({
        count,
        labels: entry.labels,
        p50: this.percentile(sorted, 50),
        p90: this.percentile(sorted, 90),
        p95: this.percentile(sorted, 95),
        p99: this.percentile(sorted, 99),
        sum: entry.sum,
        value: count > 0 ? entry.sum / count : 0,
      });
    }
    return {
      help: this.help,
      name: this.name,
      type: "histogram",
      values,
    };
  }
}

export class AtlasMetricsRegistry {
  private static instance: AtlasMetricsRegistry;

  // Execution
  public readonly executionTotal = new Counter(
    "atlas_execution_total",
    "Total user executions started"
  );
  public readonly executionSuccessTotal = new Counter(
    "atlas_execution_success_total",
    "Total executions completed successfully"
  );
  public readonly executionFailureTotal = new Counter(
    "atlas_execution_failure_total",
    "Total executions failed",
    ["failure_code"]
  );
  public readonly executionCancelledTotal = new Counter(
    "atlas_execution_cancelled_total",
    "Total executions cancelled"
  );
  public readonly executionDurationMs = new Histogram(
    "atlas_execution_duration_ms",
    "End-to-end execution duration in ms",
    ["policy"]
  );
  public readonly executionActive = new Gauge(
    "atlas_execution_active",
    "Number of currently active executions"
  );

  // Provider
  public readonly providerRequestsTotal = new Counter(
    "atlas_provider_requests_total",
    "Total provider inference calls",
    ["provider", "model", "status"]
  );
  public readonly providerLatencyMs = new Histogram(
    "atlas_provider_latency_ms",
    "Provider inference latency in ms",
    ["provider", "model"]
  );
  public readonly providerErrorsTotal = new Counter(
    "atlas_provider_errors_total",
    "Provider inference errors",
    ["provider", "model", "error_class"]
  );
  public readonly providerRateLimitedTotal = new Counter(
    "atlas_provider_rate_limited_total",
    "Provider rate limits (429)",
    ["provider", "model"]
  );
  public readonly providerTimeoutTotal = new Counter(
    "atlas_provider_timeout_total",
    "Provider request timeouts",
    ["provider", "model"]
  );
  public readonly providerActiveRequests = new Gauge(
    "atlas_provider_active_requests",
    "Current active provider inference requests"
  );

  // Agent loop
  public readonly agentTurnsPerExecution = new Histogram(
    "atlas_agent_turns_per_execution",
    "Model turns per execution attempt"
  );
  public readonly toolCallsPerExecution = new Histogram(
    "atlas_tool_calls_per_execution",
    "Tool calls per execution attempt"
  );
  public readonly duplicateToolCallPreventionsTotal = new Counter(
    "atlas_duplicate_tool_call_preventions_total",
    "Runaway tool loop prevention triggers"
  );
  public readonly agentLoopLimitTotal = new Counter(
    "atlas_agent_loop_limit_total",
    "Executions hitting iteration ceiling"
  );

  // Tools
  public readonly toolCallsTotal = new Counter(
    "atlas_tool_calls_total",
    "Total tool calls executed",
    ["tool", "status"]
  );
  public readonly toolLatencyMs = new Histogram(
    "atlas_tool_latency_ms",
    "Tool execution latency in ms",
    ["tool"]
  );
  public readonly toolFailuresTotal = new Counter(
    "atlas_tool_failures_total",
    "Total tool execution failures",
    ["tool"]
  );

  // Research
  public readonly researchSessionsTotal = new Counter(
    "atlas_research_sessions_total",
    "Total research sessions"
  );
  public readonly researchDurationMs = new Histogram(
    "atlas_research_duration_ms",
    "Research session duration in ms"
  );
  public readonly researchSourcesPerSession = new Histogram(
    "atlas_research_sources_per_session",
    "Sources evaluated per research session"
  );
  public readonly researchFailedSourcesTotal = new Counter(
    "atlas_research_failed_sources_total",
    "Failed source fetches during research"
  );

  // Browser
  public readonly browserSessionsActive = new Gauge(
    "atlas_browser_sessions_active",
    "Currently active browser sessions"
  );
  public readonly browserSessionsTotal = new Counter(
    "atlas_browser_sessions_total",
    "Total browser sessions spawned"
  );
  public readonly browserNavigationLatencyMs = new Histogram(
    "atlas_browser_navigation_latency_ms",
    "Browser navigation latency in ms"
  );
  public readonly browserFailuresTotal = new Counter(
    "atlas_browser_failures_total",
    "Total browser execution failures"
  );
  public readonly browserContextLeaksTotal = new Counter(
    "atlas_browser_context_leaks_total",
    "Detected unclosed browser contexts"
  );

  // Artifacts & Previews
  public readonly artifactsCreatedTotal = new Counter(
    "atlas_artifacts_created_total",
    "Total artifacts generated",
    ["type"]
  );
  public readonly artifactGenerationLatencyMs = new Histogram(
    "atlas_artifact_generation_latency_ms",
    "Artifact creation duration in ms",
    ["type"]
  );
  public readonly previewGenerationLatencyMs = new Histogram(
    "atlas_preview_generation_latency_ms",
    "Preview generation latency in ms",
    ["type"]
  );
  public readonly previewFailuresTotal = new Counter(
    "atlas_preview_failures_total",
    "Failed preview generations",
    ["type"]
  );
  public readonly officeConversionLatencyMs = new Histogram(
    "atlas_office_conversion_latency_ms",
    "Office document conversion latency in ms"
  );
  public readonly officeConversionFailuresTotal = new Counter(
    "atlas_office_conversion_failures_total",
    "Failed office conversions"
  );

  // Queue & Backpressure & Admission
  public readonly admissionTotal = new Counter(
    "atlas_admission_total",
    "Total requests evaluated by admission controller",
    ["decision", "reason"]
  );
  public readonly queueDepth = new Gauge(
    "atlas_queue_depth",
    "Current queue depth",
    ["queue"]
  );
  public readonly queueWaitMs = new Histogram(
    "atlas_queue_wait_ms",
    "Time spent waiting in queue in ms",
    ["queue"]
  );
  public readonly queueActiveWorkers = new Gauge(
    "atlas_queue_active_workers",
    "Active execution workers",
    ["queue"]
  );
  public readonly queueRejectedTotal = new Counter(
    "atlas_queue_rejected_total",
    "Executions rejected due to overload",
    ["queue"]
  );

  // Cancellation
  public readonly cancellationRequestsTotal = new Counter(
    "atlas_cancellation_requests_total",
    "Total cancellation requests"
  );
  public readonly cancellationSuccessTotal = new Counter(
    "atlas_cancellation_success_total",
    "Successfully cleaned up cancellations"
  );
  public readonly cancellationCleanupLatencyMs = new Histogram(
    "atlas_cancellation_cleanup_latency_ms",
    "Time to clean up cancelled resources in ms"
  );
  public readonly cancellationZombieDetectedTotal = new Counter(
    "atlas_cancellation_zombie_detected_total",
    "Zombies detected after cancellation"
  );

  public static get(): AtlasMetricsRegistry {
    if (!AtlasMetricsRegistry.instance) {
      AtlasMetricsRegistry.instance = new AtlasMetricsRegistry();
    }
    return AtlasMetricsRegistry.instance;
  }

  getAllMetrics(): MetricSummary[] {
    return [
      this.executionTotal.collect(),
      this.executionSuccessTotal.collect(),
      this.executionFailureTotal.collect(),
      this.executionCancelledTotal.collect(),
      this.executionDurationMs.collect(),
      this.executionActive.collect(),
      this.providerRequestsTotal.collect(),
      this.providerLatencyMs.collect(),
      this.providerErrorsTotal.collect(),
      this.providerRateLimitedTotal.collect(),
      this.providerTimeoutTotal.collect(),
      this.providerActiveRequests.collect(),
      this.agentTurnsPerExecution.collect(),
      this.toolCallsPerExecution.collect(),
      this.duplicateToolCallPreventionsTotal.collect(),
      this.agentLoopLimitTotal.collect(),
      this.toolCallsTotal.collect(),
      this.toolLatencyMs.collect(),
      this.toolFailuresTotal.collect(),
      this.researchSessionsTotal.collect(),
      this.researchDurationMs.collect(),
      this.researchSourcesPerSession.collect(),
      this.researchFailedSourcesTotal.collect(),
      this.browserSessionsActive.collect(),
      this.browserSessionsTotal.collect(),
      this.browserNavigationLatencyMs.collect(),
      this.browserFailuresTotal.collect(),
      this.browserContextLeaksTotal.collect(),
      this.artifactsCreatedTotal.collect(),
      this.artifactGenerationLatencyMs.collect(),
      this.previewGenerationLatencyMs.collect(),
      this.previewFailuresTotal.collect(),
      this.officeConversionLatencyMs.collect(),
      this.officeConversionFailuresTotal.collect(),
      this.admissionTotal.collect(),
      this.queueDepth.collect(),
      this.queueWaitMs.collect(),
      this.queueActiveWorkers.collect(),
      this.queueRejectedTotal.collect(),
      this.cancellationRequestsTotal.collect(),
      this.cancellationSuccessTotal.collect(),
      this.cancellationCleanupLatencyMs.collect(),
      this.cancellationZombieDetectedTotal.collect(),
    ];
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const metric of this.getAllMetrics()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const entry of metric.values) {
        const labelsStr = Object.entries(entry.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",");
        const formattedLabels = labelsStr ? `{${labelsStr}}` : "";
        if (metric.type === "histogram") {
          lines.push(
            `${metric.name}_count${formattedLabels} ${entry.count ?? 0}`
          );
          lines.push(`${metric.name}_sum${formattedLabels} ${entry.sum ?? 0}`);
          lines.push(
            `${metric.name}{quantile="0.5"${labelsStr ? `,${labelsStr}` : ""}} ${entry.p50 ?? 0}`
          );
          lines.push(
            `${metric.name}{quantile="0.9"${labelsStr ? `,${labelsStr}` : ""}} ${entry.p90 ?? 0}`
          );
          lines.push(
            `${metric.name}{quantile="0.95"${labelsStr ? `,${labelsStr}` : ""}} ${entry.p95 ?? 0}`
          );
          lines.push(
            `${metric.name}{quantile="0.99"${labelsStr ? `,${labelsStr}` : ""}} ${entry.p99 ?? 0}`
          );
        } else {
          lines.push(`${metric.name}${formattedLabels} ${entry.value}`);
        }
      }
    }
    return lines.join("\n");
  }

  reset(): void {
    this.executionTotal.reset();
    this.executionSuccessTotal.reset();
    this.executionFailureTotal.reset();
    this.executionCancelledTotal.reset();
    this.executionDurationMs.reset();
    this.executionActive.reset();
    this.providerRequestsTotal.reset();
    this.providerLatencyMs.reset();
    this.providerErrorsTotal.reset();
    this.providerRateLimitedTotal.reset();
    this.providerTimeoutTotal.reset();
    this.providerActiveRequests.reset();
    this.agentTurnsPerExecution.reset();
    this.toolCallsPerExecution.reset();
    this.duplicateToolCallPreventionsTotal.reset();
    this.agentLoopLimitTotal.reset();
    this.toolCallsTotal.reset();
    this.toolLatencyMs.reset();
    this.toolFailuresTotal.reset();
    this.researchSessionsTotal.reset();
    this.researchDurationMs.reset();
    this.researchSourcesPerSession.reset();
    this.researchFailedSourcesTotal.reset();
    this.browserSessionsActive.reset();
    this.browserSessionsTotal.reset();
    this.browserNavigationLatencyMs.reset();
    this.browserFailuresTotal.reset();
    this.browserContextLeaksTotal.reset();
    this.artifactsCreatedTotal.reset();
    this.artifactGenerationLatencyMs.reset();
    this.previewGenerationLatencyMs.reset();
    this.previewFailuresTotal.reset();
    this.officeConversionLatencyMs.reset();
    this.officeConversionFailuresTotal.reset();
    this.admissionTotal.reset();
    this.queueDepth.reset();
    this.queueWaitMs.reset();
    this.queueActiveWorkers.reset();
    this.queueRejectedTotal.reset();
    this.cancellationRequestsTotal.reset();
    this.cancellationSuccessTotal.reset();
    this.cancellationCleanupLatencyMs.reset();
    this.cancellationZombieDetectedTotal.reset();
  }
}

export const metrics = AtlasMetricsRegistry.get();
