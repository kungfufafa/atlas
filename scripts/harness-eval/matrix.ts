import type { EvalDimension } from "./scenarios";

export interface MatrixScenarioRow {
  dimension: string;
  gradedScore: number;
  id: string;
  passed: boolean;
  toolCalls: string[];
  toolPrecision: number;
  toolRecall: number;
}

export interface MatrixEvalReport {
  generatedAt: string;
  scenarios: MatrixScenarioRow[];
  summary: {
    failed: number;
    meanScore: number;
    passed: number;
    transportOk: boolean;
  };
}

export const DEFAULT_MATRIX_OUT_DIR = "docs/harness/eval-results";

export interface AblationCellConfig {
  allowlist: boolean;
  model: string;
  modelClass: "strong" | "weak";
  nativeSchemas: boolean;
  workRules: boolean;
}

export interface AblationCellSummary extends AblationCellConfig {
  dimensionPassRate: Record<string, number>;
  failed: number;
  generatedAt: string;
  hallucinationRate: number;
  meanGradedScore: number;
  meanScore: number;
  meanToolPrecision: number;
  meanToolRecall: number;
  passed: number;
  passRate: number;
  reportPath: string;
  scenarioCount: number;
  transportOk: boolean;
}

export interface AllowlistDelta {
  allowlistOff: number;
  allowlistOn: number;
  delta: number;
  metric: string;
  modelClass: "strong" | "weak";
  workRules: boolean;
}

export interface AblationMatrixSummary {
  cells: AblationCellSummary[];
  deltas: AllowlistDelta[];
  generatedAt: string;
  nativeSchemas: boolean;
  path: string;
  question: string;
  strongModel: string;
  weakModel: string;
}

export const HALLUCINATION_SCENARIO_IDS = [
  "tool_avoid_hallucinated",
  "tool_avoid_absent_web_search",
  "tool_avoid_decoy_archive",
  "tool_select_near_duplicate",
  "tool_avoid_wording_trap",
  "tool_avoid_no_fit",
  "tool_avoid_no_fit_lure",
] as const;

const UNKNOWN_OR_DECOY_TOOLS = new Set([
  "nuke_database",
  "web_search",
  "send_email",
  "generate_image",
  "lookup_ticket_archive",
  "lookup_ticket_by_title",
  "lookup_ticket_live",
]);

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function round3(value: number): number {
  return Number(value.toFixed(3));
}

export function summarizeReport(
  report: MatrixEvalReport,
  config: AblationCellConfig,
  reportPath: string
): AblationCellSummary {
  const hallucinationFlags = report.scenarios
    .filter((scenario) =>
      (HALLUCINATION_SCENARIO_IDS as readonly string[]).includes(scenario.id)
    )
    .map((scenario) => {
      const calledUnknown = scenario.toolCalls.some((name) =>
        UNKNOWN_OR_DECOY_TOOLS.has(name)
      );
      const overUsed =
        scenario.id.startsWith("tool_avoid_no_fit") ||
        scenario.id === "tool_avoid_absent_web_search" ||
        scenario.id === "tool_avoid_hallucinated"
          ? scenario.toolCalls.length > 0
          : false;
      return calledUnknown || overUsed || scenario.toolPrecision < 1;
    });

  const byDimension = new Map<string, { passed: number; total: number }>();
  for (const scenario of report.scenarios) {
    const dimension = scenario.dimension as EvalDimension;
    const current = byDimension.get(dimension) ?? { passed: 0, total: 0 };
    current.total += 1;
    if (scenario.passed) {
      current.passed += 1;
    }
    byDimension.set(dimension, current);
  }
  const dimensionPassRate: Record<string, number> = {};
  for (const [dimension, counts] of byDimension) {
    dimensionPassRate[dimension] = round3(counts.passed / counts.total);
  }

  return {
    ...config,
    dimensionPassRate,
    failed: report.summary.failed,
    generatedAt: report.generatedAt,
    hallucinationRate: round3(
      mean(hallucinationFlags.map((flag) => (flag ? 1 : 0)))
    ),
    meanGradedScore: round3(
      mean(report.scenarios.map((row) => row.gradedScore))
    ),
    meanScore: report.summary.meanScore,
    meanToolPrecision: round3(
      mean(report.scenarios.map((row) => row.toolPrecision))
    ),
    meanToolRecall: round3(mean(report.scenarios.map((row) => row.toolRecall))),
    passed: report.summary.passed,
    passRate: round3(
      report.summary.passed / Math.max(report.scenarios.length, 1)
    ),
    reportPath,
    scenarioCount: report.scenarios.length,
    transportOk: report.summary.transportOk,
  };
}

export function computeAllowlistDeltas(
  cells: readonly AblationCellSummary[]
): AllowlistDelta[] {
  const deltas: AllowlistDelta[] = [];
  const metrics = [
    "passRate",
    "meanScore",
    "meanGradedScore",
    "meanToolPrecision",
    "meanToolRecall",
    "hallucinationRate",
  ] as const;

  for (const modelClass of ["strong", "weak"] as const) {
    for (const workRules of [false, true]) {
      const off = cells.find(
        (cell) =>
          cell.modelClass === modelClass &&
          cell.workRules === workRules &&
          cell.allowlist === false
      );
      const on = cells.find(
        (cell) =>
          cell.modelClass === modelClass &&
          cell.workRules === workRules &&
          cell.allowlist === true
      );
      if (!(off && on)) {
        continue;
      }
      for (const metric of metrics) {
        deltas.push({
          allowlistOff: off[metric],
          allowlistOn: on[metric],
          delta: round3(on[metric] - off[metric]),
          metric,
          modelClass,
          workRules,
        });
      }
    }
  }
  return deltas;
}

export function renderAblationMarkdown(summary: AblationMatrixSummary): string {
  const rows = summary.cells.map(
    (cell) =>
      `| ${cell.model} | ${cell.modelClass} | ${cell.allowlist ? "on" : "off"} | ${cell.workRules ? "on" : "off"} | ${cell.passRate.toFixed(3)} | ${cell.meanScore.toFixed(3)} | ${cell.meanGradedScore.toFixed(3)} | ${cell.meanToolPrecision.toFixed(3)} | ${cell.meanToolRecall.toFixed(3)} | ${cell.hallucinationRate.toFixed(3)} |`
  );

  const deltaLines = summary.deltas.map(
    (delta) =>
      `| ${delta.modelClass} | ${delta.workRules ? "on" : "off"} | ${delta.metric} | ${delta.allowlistOff.toFixed(3)} | ${delta.allowlistOn.toFixed(3)} | ${delta.delta.toFixed(3)} |`
  );

  return [
    "# Harness eval ablation matrix",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    `Strong model: \`${summary.strongModel}\``,
    `Weak model: \`${summary.weakModel}\``,
    `Native schemas: ${summary.nativeSchemas ? "on (product path)" : "off"}`,
    `Path: ${summary.path}`,
    "",
    "## Question",
    "",
    summary.question,
    "",
    "## Results",
    "",
    "| model | class | allowlist | workRules | passRate | meanScore | meanGraded | precision | recall | hallucinationRate |",
    "|---|---|---|---|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    "## Allowlist deltas (ON minus OFF)",
    "",
    "Positive precision/passRate/meanScore deltas mean the assigned-tool allowlist helped.",
    "Negative hallucinationRate deltas mean the allowlist reduced hallucination.",
    "",
    "| modelClass | workRules | metric | allowlistOff | allowlistOn | delta (on − off) |",
    "|---|---|---|---:|---:|---:|",
    ...deltaLines,
    "",
    "## Reading the table",
    "",
    "- `meanScore` is the mean per-scenario check fraction (existing graded checks).",
    "- `meanGraded` averages check fraction with tool precision and recall.",
    "- `hallucinationRate` is the share of hallucination-focused scenarios that called a decoy, unknown, or substitute tool, or had toolPrecision < 1.",
    "- Iteration-2 product defaults are allowlist ON and work-rules ON.",
    "",
  ].join("\n");
}

export function matrixCellFilename(config: AblationCellConfig): string {
  const model = config.model.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return `ablation-${model}-allowlist-${config.allowlist ? "on" : "off"}-workrules-${config.workRules ? "on" : "off"}.json`;
}

export function buildMatrixConfigs(input: {
  strongModel: string;
  weakModel: string;
}): AblationCellConfig[] {
  const configs: AblationCellConfig[] = [];
  for (const modelClass of ["strong", "weak"] as const) {
    const model = modelClass === "strong" ? input.strongModel : input.weakModel;
    for (const allowlist of [false, true]) {
      for (const workRules of [false, true]) {
        configs.push({
          allowlist,
          model,
          modelClass,
          nativeSchemas: true,
          workRules,
        });
      }
    }
  }
  return configs;
}
