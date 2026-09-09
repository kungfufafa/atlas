import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const directory = process.argv[2];
const output = process.argv[3];
if (!(directory && output)) {
  throw new Error(
    "Usage: bun run scripts/harness-channel-audit/sanitize-evidence.ts <audit-directory> <output.json>"
  );
}
const repository = resolve(import.meta.dir, "../..");
const secretKeys =
  /^(?:authorization|cookie|cookies|apiKey|password|passwordHash|token|sessionToken|csrfToken)$/i;
const shareToken = /nkshare[A-Za-z0-9_-]+/g;
const files = [
  "failed-artifacts-before.log",
  "attempt1.log",
  "attempt2-report.json",
  "report.json",
  "schema-fix.log",
  "schema-fixed2.log",
  "channels-attempt1-report.json",
  "channel-report.json",
  "cache-refresh-attempt1-report.json",
  "cache-refresh-attempt2-report.json",
  "cache-refresh-report.json",
  "restart-attempt1-report.json",
  "restart-attempt2-report.json",
  "restart-report.json",
  "approval-auth-report.json",
  "inbound-report.json",
  "boundaries-report.json",
  "focused-regression.log",
  "channel-full-handler-regression.log",
  "channel-full-handler-before.log",
  "protocol-persistence.log",
  "portable-runner-attempt1.log",
  "portable-runner-report.json",
  "portable-http-report.json",
  "portable-protocol-check.log",
] as const;

function sanitizeText(text: string): string {
  return text
    .replaceAll(repository, "<repository>")
    .replaceAll(resolve(directory), "<audit-directory>")
    .replace(shareToken, "<redacted-local-share-token>")
    .replace(
      /\/private\/var\/folders\/[^\s"']+|\/var\/folders\/[^\s"']+/g,
      "<temporary-path>"
    );
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        secretKeys.test(key) ? "<redacted>" : sanitize(entry),
      ])
    );
  }
  return value;
}

const attempts: Array<{
  file: string;
  evidence?: unknown;
  unavailable?: boolean;
}> = [];
for (const file of files) {
  try {
    const text = await readFile(join(directory, file), "utf8");
    attempts.push({
      evidence: sanitize(file.endsWith(".json") ? JSON.parse(text) : text),
      file,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    attempts.push({ file, unavailable: true });
  }
}
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      attempts,
      generatedAt: new Date().toISOString(),
      interpretation: {
        channelShareRetry:
          "channels-attempt1 proves upload bytes/retry/limits. Later all-channel share assertion failed because empty worker caches cannot recover an existing plaintext token. Same-worker relative-cache defect fixed; cache-refresh-report.json separately verifies real publication/reload/refresh with all five sends retained.",
        historicalExitCodes:
          "Some initial catch-and-continue fixtures exited zero with failed cases; use each assertion report. Current runner exits nonzero after saving failures.",
        liveClaude:
          "Blocked: Atlas-isolated runtime not authenticated. Installed SDK MCP protocol tests are separate evidence.",
        withdrawn:
          "restart-attempt1-report.json H09 said pass without an actual restart. Withdrawn; restart-attempt2 required a SIGKILL prerequisite and failed; restart-report.json later proves actual restart.",
      },
      redactions: [
        "Local share tokens and secret-bearing field names",
        "Repository and temporary filesystem prefixes",
      ],
      scope:
        "Local production HTTP/SQLite/protected-file and controlled SDK/channel transport audit. No live provider or channel claim.",
    },
    null,
    2
  )
);
