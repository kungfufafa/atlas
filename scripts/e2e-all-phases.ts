import { execSync } from "node:child_process";

const phases = [
  {
    name: "Phase 1: Web Primitives Maturity",
    script: "scripts/e2e-phase1-web-primitives.ts",
  },
  {
    name: "Phase 2: Interactive Browser Tool",
    script: "scripts/e2e-phase2-browser-tool.ts",
  },
  {
    name: "Phase 3: Rich Artifact Engine",
    script: "scripts/e2e-phase3-rich-artifacts.ts",
  },
  {
    name: "Phase 4: Personal & Project Memory",
    script: "scripts/e2e-phase4-memory.ts",
  },
  {
    name: "Phase 5: Conversation Retrieval",
    script: "scripts/e2e-phase5-conversation-retrieval.ts",
  },
  { name: "Phase 6: MCP Extension Layer", script: "scripts/e2e-phase6-mcp.ts" },
  {
    name: "Phase 7: Research Engine",
    script: "scripts/e2e-phase7-research-engine.ts",
  },
];

console.log(
  "================================================================================"
);
console.log(
  "🚀 EXECUTING MASTER SUITE: ALL 7 ATLAS CAPABILITY GAPS AUTOMATED BROWSER E2E 🚀"
);
console.log(
  "================================================================================\n"
);

let passed = 0;

for (const [idx, phase] of phases.entries()) {
  console.log(`\n[${idx + 1}/7] RUNNING ${phase.name.toUpperCase()}...`);
  try {
    const output = execSync(`bun run ${phase.script}`, {
      env: { ...process.env, ATLAS_TEST_BASE_URL: "http://127.0.0.1:4310" },
      stdio: "pipe",
    }).toString();
    console.log(output.trim());
    console.log(`✅ [${idx + 1}/7] ${phase.name} PASSED!`);
    passed += 1;
  } catch (error: any) {
    console.error(`❌ [${idx + 1}/7] ${phase.name} FAILED!`);
    if (error.stdout) {
      console.log(error.stdout.toString());
    }
    if (error.stderr) {
      console.error(error.stderr.toString());
    }
    process.exit(1);
  }
}

console.log(
  "\n================================================================================"
);
console.log(
  `🏆 ALL ${passed}/7 ATLAS CAPABILITY PHASES VERIFIED AND PASSED 100% E2E! 🏆`
);
console.log(
  "================================================================================"
);
