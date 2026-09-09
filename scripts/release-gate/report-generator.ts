import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSensitiveData } from "../../packages/core/src/secret-redaction";
import type { DecisionEngineResult } from "./decision-engine";
import type { ProvisionedEnvironment } from "./environment-provisioner";

export interface ReportMetadata {
  commitSha?: string;
  completedAt: string;
  environment: string;
  runId: string;
  startedAt: string;
}

export class ReportGenerator {
  generateReports(
    result: DecisionEngineResult,
    env: ProvisionedEnvironment,
    metadata: ReportMetadata,
    outputDir: string = process.cwd()
  ): { jsonPath: string; mdPath: string } {
    // 1. JSON Report (Phase 26)
    const providerCompatibilityBlock =
      this.buildProviderCompatibilityBlock(result);

    const jsonReport = redactSensitiveData({
      blockingFailures: result.blockingReasons,
      checks: result.checks,
      commitSha: metadata.commitSha ?? "local-dev",
      completedAt: metadata.completedAt,
      coreDecision: result.coreDecision,
      environment: metadata.environment,
      evidenceScope:
        "Core suites use a real isolated Atlas server with a deterministic mock model. The optional provider smoke is reported separately; no full file/provider/channel acceptance matrix is implied.",
      providerCompatibility: providerCompatibilityBlock,
      providerDetails: result.providerDetails,
      runId: metadata.runId,
      startedAt: metadata.startedAt,
      summary: result.summary,
      warnings: result.warnings,
    });

    const jsonPath = join(outputDir, "release-gate-report.json");
    writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), "utf8");

    // 2. Markdown Report
    const mdLines: string[] = [
      "# Atlas Release Gate Report",
      "",
      `**Run ID**: \`${metadata.runId}\`  `,
      `**Started**: ${metadata.startedAt}  `,
      `**Completed**: ${metadata.completedAt}  `,
      `**Duration**: ${(result.summary.durationMs / 1000).toFixed(2)}s  `,
      `**Environment**: \`${metadata.environment}\`  `,
      "",
      "---",
      "",
      `## Core Decision: **${result.coreDecision}**`,
      "",
      "Scope: isolated Atlas server and deterministic mock model. Live provider smoke is reported separately. This decision does not establish the complete file/provider/channel acceptance matrix or production capacity.",
      "",
      "| Status | Count |",
      "| :--- | :--- |",
      `| Total Checks | ${result.summary.total} |`,
      `| Passed | ${result.summary.passed} |`,
      `| Failed | ${result.summary.failed} |`,
      `| Skipped | ${result.summary.skipped} |`,
      `| Warnings | ${result.summary.warnings} |`,
      "",
    ];

    if (result.blockingReasons.length > 0) {
      mdLines.push("### ❌ Blocking Reasons");
      for (const reason of result.blockingReasons) {
        mdLines.push(`- ${reason}`);
      }
      mdLines.push("");
    }

    if (result.warnings.length > 0) {
      mdLines.push("### ⚠️ Warnings");
      for (const warning of result.warnings) {
        mdLines.push(`- ${warning}`);
      }
      mdLines.push("");
    }

    mdLines.push("## Check Matrix");
    mdLines.push("");
    mdLines.push("| Category | Check ID | Required | Status | Duration |");
    mdLines.push("| :--- | :--- | :--- | :--- | :--- |");

    for (const check of result.checks) {
      const statusEmoji =
        check.status === "pass"
          ? "✅ PASS"
          : check.status === "fail"
            ? "❌ FAIL"
            : check.status === "skipped"
              ? "⏭️ SKIPPED"
              : "⚠️ WARN";

      mdLines.push(
        `| ${check.category} | \`${check.id}\` | ${check.required ? "Yes" : "No"} | ${statusEmoji} | ${check.durationMs}ms |`
      );
    }

    mdLines.push("");
    mdLines.push("---");
    mdLines.push("");

    // Phase 27 — Human report with per-check telemetry
    mdLines.push("## Real Provider Compatibility");
    mdLines.push("");
    mdLines.push(`**Provider Status**: **${result.providerCompatibility}**`);
    if (result.providerDetails) {
      mdLines.push(`- **Provider**: ${result.providerDetails.provider}`);
      mdLines.push(`- **Type**: ${result.providerDetails.providerType}`);
      mdLines.push(`- **Base URL**: \`${result.providerDetails.baseUrl}\``);
      mdLines.push(`- **Model**: \`${result.providerDetails.model}\``);
      mdLines.push(`- **Summary**: ${result.providerDetails.summary}`);
    } else {
      mdLines.push(
        "- Smoke suite skipped (set `ATLAS_RUN_PROVIDER_SMOKE=1` and `TOKENROUTER_API_KEY` to run)."
      );
    }

    if (result.providerCheckReports && result.providerCheckReports.length > 0) {
      const inferenceReports = result.providerCheckReports.filter(
        (r) => r.category === "real_inference"
      );
      const localReports = result.providerCheckReports.filter(
        (r) => r.category === "local_contract"
      );

      if (inferenceReports.length > 0) {
        mdLines.push("");
        mdLines.push("### REAL TOKENROUTER INFERENCE");
        mdLines.push("");
        mdLines.push(
          "| Check | Provider Requests | Tool Calls | Tool Results | Agent Turns | Duration | Status |"
        );
        mdLines.push("| :--- | :---: | :---: | :---: | :---: | :---: | :--- |");
        for (const r of inferenceReports) {
          const s = r.status === "pass" ? "✅ PASS" : "❌ FAIL";
          mdLines.push(
            `| \`${r.id}\` | ${r.providerRequests} | ${r.toolCalls} | ${r.toolResults} | ${r.agentTurns} | ${r.durationMs}ms | ${s} |`
          );
        }
      }

      if (localReports.length > 0) {
        mdLines.push("");
        mdLines.push("### ATLAS LOCAL CONTRACTS");
        mdLines.push("");
        mdLines.push("| Check | Status | Duration |");
        mdLines.push("| :--- | :--- | :--- |");
        for (const r of localReports) {
          const s = r.status === "pass" ? "✅ PASS" : "❌ FAIL";
          mdLines.push(`| \`${r.id}\` | ${s} | ${r.durationMs}ms |`);
        }
      }
    }

    const mdContent = mdLines.join("\n");
    const mdPath = join(outputDir, "release-gate-report.md");
    writeFileSync(mdPath, mdContent, "utf8");

    return { jsonPath, mdPath };
  }

  printTerminalSummary(result: DecisionEngineResult): void {
    console.log(
      "\n============================================================"
    );
    console.log("ATLAS RELEASE GATE SUMMARY");
    console.log("============================================================");

    // Core gate checks (non-smoke)
    const coreChecks = result.checks.filter(
      (c) =>
        c.category !== "TokenRouter Real Inference" &&
        c.category !== "Atlas Local Contract"
    );

    for (const check of coreChecks) {
      const padCategory = check.category.padEnd(24);
      const padId = check.id.padEnd(36);
      const statusBadge =
        check.status === "pass"
          ? "\x1b[32mPASS\x1b[0m"
          : check.status === "fail"
            ? "\x1b[31mFAIL\x1b[0m"
            : check.status === "skipped"
              ? "\x1b[33mSKIPPED\x1b[0m"
              : "\x1b[33mWARN\x1b[0m";

      console.log(
        `${padCategory} ${padId} ${statusBadge} (${check.durationMs}ms)`
      );
    }

    console.log("------------------------------------------------------------");
    if (result.coreDecision === "RELEASE") {
      console.log("\x1b[32mCORE DECISION: RELEASE\x1b[0m");
    } else {
      console.log("\x1b[31mCORE DECISION: BLOCKED\x1b[0m");
      console.log("\nBlocking reasons:");
      for (const reason of result.blockingReasons) {
        console.log(` - \x1b[31m${reason}\x1b[0m`);
      }
    }

    // Phase 15 & 27 — Category-separated provider smoke output
    if (result.providerCheckReports && result.providerCheckReports.length > 0) {
      const inferenceReports = result.providerCheckReports.filter(
        (r) => r.category === "real_inference"
      );
      const localReports = result.providerCheckReports.filter(
        (r) => r.category === "local_contract"
      );

      if (inferenceReports.length > 0) {
        console.log(
          "\n------------------------------------------------------------"
        );
        console.log(
          `REAL TOKENROUTER INFERENCE  ${result.providerDetails ? `[${result.providerDetails.model}]` : ""}`
        );
        console.log(
          "------------------------------------------------------------"
        );
        for (const r of inferenceReports) {
          const badge =
            r.status === "pass" ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
          const label = r.id.padEnd(38);
          const detail = `provider requests: ${r.providerRequests}  tool calls: ${r.toolCalls}  agent turns: ${r.agentTurns}  ${r.durationMs}ms`;
          console.log(`  ${label} ${badge}`);
          console.log(`    ${detail}`);
          if (r.failureCode) {
            console.log(`    \x1b[31m[${r.failureCode}]\x1b[0m`);
          }
        }
      }

      if (localReports.length > 0) {
        console.log(
          "\n------------------------------------------------------------"
        );
        console.log("ATLAS LOCAL CONTRACTS");
        console.log(
          "------------------------------------------------------------"
        );
        for (const r of localReports) {
          const badge =
            r.status === "pass" ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
          const label = r.id.padEnd(38);
          console.log(`  ${label} ${badge} (${r.durationMs}ms)`);
        }
      }
    }

    console.log("------------------------------------------------------------");
    console.log(`PROVIDER COMPATIBILITY: ${result.providerCompatibility}`);
    if (result.providerDetails) {
      console.log(
        ` - Provider: ${result.providerDetails.provider} (${result.providerDetails.model})`
      );
      console.log(` - Status: ${result.providerDetails.summary}`);
    }
    console.log(
      "============================================================\n"
    );
  }

  // ================================================================
  // PRIVATE HELPERS
  // ================================================================

  private buildProviderCompatibilityBlock(
    result: DecisionEngineResult
  ): Record<string, unknown> {
    const checks: Array<Record<string, unknown>> = (
      result.providerCheckReports ?? []
    )
      .filter((r) => r.category === "real_inference")
      .map((r) => ({
        agentTurns: r.agentTurns,
        durationMs: r.durationMs,
        id: r.id,
        providerRequests: r.providerRequests,
        providerResponses: r.providerResponses,
        status: r.status,
        toolCalls: r.toolCalls,
        toolResults: r.toolResults,
        ...(r.failureCode ? { failureCode: r.failureCode } : {}),
      }));

    return {
      checks,
      model: result.providerDetails?.model ?? "unknown",
      provider: result.providerDetails?.provider?.toLowerCase() ?? "unknown",
      status:
        result.providerCompatibility === "COMPATIBLE"
          ? "compatible"
          : result.providerCompatibility === "PARTIAL"
            ? "partial"
            : result.providerCompatibility === "SKIPPED"
              ? "skipped"
              : "blocked",
    };
  }
}
