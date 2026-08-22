import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactStringValue } from "./secret-redaction";

export interface SecretScanFinding {
  column?: number;
  file?: string;
  lineNumber?: number;
  patternName: string;
  redactedSnippet: string;
}

const HIGH_CONFIDENCE_SECRET_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
}> = [
  {
    name: "Private Key Block",
    pattern: /-----BEGIN [A-Z0-9_ -]+ PRIVATE KEY-----/i,
  },
  {
    name: "OpenAI-style API Key",
    pattern: /\bsk-[a-zA-Z0-9]{20,}\b/,
  },
  {
    name: "TokenRouter API Key",
    pattern: /\btokenrouter-[a-zA-Z0-9]{12,}\b/,
  },
  {
    name: "GitHub Personal Access Token",
    pattern: /\bghp_[a-zA-Z0-9]{30,}\b/,
  },
  {
    name: "Slack Bot Token",
    pattern: /\bxoxb-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{20,}\b/,
  },
  {
    name: "Database Credentials in URI",
    pattern:
      /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[a-zA-Z0-9_]+:[a-zA-Z0-9_!#$%&*+-]+@/,
  },
  {
    name: "Bearer Token with High Entropy",
    pattern: /Bearer\s+[A-Za-z0-9_\-.~+/=]{32,}/,
  },
];

const DEFAULT_IGNORE_PATTERNS = [
  /node_modules/,
  /\.git\//,
  /\.DS_Store/,
  /dist\//,
  /\.next\//,
  /\.turbo\//,
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.webp$/,
  /\.pdf$/,
  /\.docx$/,
  /\.xlsx$/,
  /\.pptx$/,
  /\.sqlite$/,
  /\.lock$/,
  /cassettes\//,
  /\.local-poc\//,
  /secret-scanner\.ts$/,
  /secret-redaction\.ts$/,
  /secret-redaction\.test\.ts$/,
];

export class SecretScanner {
  private ignoredPatterns: RegExp[];

  constructor(customIgnored: RegExp[] = []) {
    this.ignoredPatterns = [...DEFAULT_IGNORE_PATTERNS, ...customIgnored];
  }

  scanText(content: string, sourceName?: string): SecretScanFinding[] {
    const findings: SecretScanFinding[] = [];
    const lines = content.split(/\r?\n/);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

      for (const { name, pattern } of HIGH_CONFIDENCE_SECRET_PATTERNS) {
        const match = pattern.exec(line);
        if (match) {
          // Check if this line is in a test fixture or explicitly marked safe
          const lower = line.toLowerCase();
          if (
            lower.includes("[redacted]") ||
            lower.includes("••••••••") ||
            lower.includes("sk-test") ||
            lower.includes("tokenrouter-key") ||
            lower.includes("sk-ant-test") ||
            lower.includes("sk-openai-test") ||
            lower.includes("sk-1234567890") ||
            lower.includes("dummy") ||
            lower.includes("mock") ||
            lower.includes("fake") ||
            lower.includes("example.com")
          ) {
            continue;
          }

          const start = Math.max(0, match.index - 20);
          const end = Math.min(line.length, match.index + match[0].length + 20);
          const snippet = line.slice(start, end);

          findings.push({
            file: sourceName,
            lineNumber: lineIdx + 1,
            patternName: name,
            redactedSnippet: redactStringValue(snippet),
          });
        }
      }
    }

    return findings;
  }

  scanDirectory(dirPath: string): SecretScanFinding[] {
    const findings: SecretScanFinding[] = [];

    const walk = (currentPath: string) => {
      if (!existsSync(currentPath)) {
        return;
      }

      const entries = readdirSync(currentPath);
      for (const entry of entries) {
        const fullPath = join(currentPath, entry);

        if (this.ignoredPatterns.some((pattern) => pattern.test(fullPath))) {
          continue;
        }

        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (stat.isFile()) {
            if (stat.size > 2 * 1024 * 1024) {
              // Skip files larger than 2MB
              continue;
            }
            const content = readFileSync(fullPath, "utf8");
            const fileFindings = this.scanText(content, fullPath);
            findings.push(...fileFindings);
          }
        } catch {
          // ignore unreadable files
        }
      }
    };

    walk(dirPath);
    return findings;
  }
}
