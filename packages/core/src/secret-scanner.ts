import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
    pattern: /-----BEGIN (?:[A-Z0-9_ -]+ )?PRIVATE KEY-----/i,
  },
  {
    name: "sk-prefixed API Key",
    pattern: /\bsk-[a-zA-Z0-9_-]{20,}\b/,
  },
  {
    name: "TokenRouter API Key",
    pattern: /\btokenrouter-[a-zA-Z0-9]{12,}\b/,
  },
  {
    name: "GitHub Access Token",
    pattern: /\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{50,})\b/,
  },
  {
    name: "Slack Access Token",
    pattern: /\bxox[baprs]-[a-zA-Z0-9-]{20,}\b/,
  },
  {
    name: "AWS Access Key ID",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    name: "Database Credentials in URI",
    pattern:
      /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:(?!\[REDACTED\]@)[^@\s/]+@/i,
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
  /\.local-poc\//,
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
          findings.push({
            column: match.index + 1,
            file: sourceName,
            lineNumber: lineIdx + 1,
            patternName: name,
            redactedSnippet: "[REDACTED]",
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
