import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretScanner } from "./secret-scanner";
import { SYNTHETIC_SECRET_FIXTURES } from "./testing/synthetic-secret-fixtures";

const DETECTABLE_FIXTURES = [
  ["Anthropic key", SYNTHETIC_SECRET_FIXTURES.anthropicApiKey],
  ["AWS access key", SYNTHETIC_SECRET_FIXTURES.awsAccessKeyId],
  ["bearer token", SYNTHETIC_SECRET_FIXTURES.bearerToken],
  ["database URI", SYNTHETIC_SECRET_FIXTURES.databaseUri],
  ["GitHub token", SYNTHETIC_SECRET_FIXTURES.githubAccessToken],
  ["OpenAI key", SYNTHETIC_SECRET_FIXTURES.openAiApiKey],
  ["OpenAI project key", SYNTHETIC_SECRET_FIXTURES.openAiProjectApiKey],
  ["private key", SYNTHETIC_SECRET_FIXTURES.privateKey],
  ["RSA private key", SYNTHETIC_SECRET_FIXTURES.rsaPrivateKey],
  ["Slack token", SYNTHETIC_SECRET_FIXTURES.slackAccessToken],
  ["TokenRouter key", SYNTHETIC_SECRET_FIXTURES.tokenRouterApiKey],
] as const;

describe("SecretScanner", () => {
  const scanner = new SecretScanner();

  for (const [label, fixture] of DETECTABLE_FIXTURES) {
    test(`detects a ${label} even in a test source`, () => {
      const findings = scanner.scanText(
        `const mockDummyFakeCredential = "${fixture}";`,
        "credential-fixture.test.ts"
      );

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.redactedSnippet).toBe("[REDACTED]");
        expect(finding.column).toBeGreaterThan(0);
      }
    });
  }

  test("scans test and cassette directories instead of ignoring them", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlas-secret-scan-"));
    const cassetteDir = join(root, "cassettes");

    try {
      await mkdir(cassetteDir);
      await writeFile(
        join(root, "credential.test.ts"),
        `export const key = "${SYNTHETIC_SECRET_FIXTURES.openAiApiKey}";`,
        "utf8"
      );
      await writeFile(
        join(cassetteDir, "provider.json"),
        JSON.stringify({
          authorization: SYNTHETIC_SECRET_FIXTURES.bearerToken,
        }),
        "utf8"
      );

      const findings = scanner.scanDirectory(root);
      const files = findings.map((finding) => finding.file);

      expect(files.some((file) => file?.endsWith("credential.test.ts"))).toBe(
        true
      );
      expect(files.some((file) => file?.endsWith("provider.json"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps the synthetic fixture module free of literal credentials", async () => {
    const fixtureSource = await readFile(
      join(import.meta.dir, "testing", "synthetic-secret-fixtures.ts"),
      "utf8"
    );

    expect(
      scanner.scanText(fixtureSource, "synthetic-secret-fixtures.ts")
    ).toEqual([]);
  });

  test("accepts an exact redacted database password placeholder", () => {
    const findings = scanner.scanText(
      "postgresql://atlas:[REDACTED]@db.invalid:5432/atlas",
      "diagnostic.log"
    );

    expect(findings).toEqual([]);
  });
});
