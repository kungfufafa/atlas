import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { scrubText } from "./error-tracking-scrub";
import { SYNTHETIC_SECRET_FIXTURES } from "./testing/synthetic-secret-fixtures";

describe("scrubText", () => {
  const credentials: Array<[string, string]> = [
    [SYNTHETIC_SECRET_FIXTURES.anthropicApiKey, "Anthropic key"],
    [SYNTHETIC_SECRET_FIXTURES.openAiProjectApiKey, "OpenAI key"],
    [SYNTHETIC_SECRET_FIXTURES.githubAccessToken, "GitHub token"],
    [SYNTHETIC_SECRET_FIXTURES.slackAccessToken, "Slack token"],
    [SYNTHETIC_SECRET_FIXTURES.awsAccessKeyId, "AWS access key"],
    [SYNTHETIC_SECRET_FIXTURES.bearerPayload, "bearer token"],
  ];

  for (const [secret, label] of credentials) {
    test(`removes ${label}`, () => {
      const prefix = label === "bearer token" ? "Bearer " : "failed with ";
      expect(scrubText(`${prefix}${secret}`)).not.toContain(secret);
    });
  }

  test("removes named credential assignments", () => {
    const secret = "abcd1234efgh5678";

    expect(scrubText(`ATLAS_API_TOKEN=${secret}`)).not.toContain(secret);
  });

  test("removes quoted credentials containing spaces", () => {
    const secret = "correct horse battery staple";

    expect(scrubText(`password='${secret}'`)).not.toContain(secret);
    expect(scrubText(`password="${secret}"`)).not.toContain(secret);
  });

  test("removes complete and truncated private keys", () => {
    const secret = "short private material";
    const complete = SYNTHETIC_SECRET_FIXTURES.privateKey.replace(
      "ATLAS_SYNTHETIC_PRIVATE_KEY_MATERIAL",
      secret
    );
    const truncated = SYNTHETIC_SECRET_FIXTURES.rsaPrivateKey
      .split("\n")
      .slice(0, -1)
      .join("\n")
      .replace("ATLAS_SYNTHETIC_PRIVATE_KEY_MATERIAL", secret);

    expect(scrubText(complete)).not.toContain(secret);
    expect(scrubText(truncated)).not.toContain(secret);
  });

  test("removes authorization headers, cookies, addresses, and URLs", () => {
    const sensitive = [
      "Authorization: Basic dXNlcjpzZWNyZXQ=",
      "Cookie: sessionid=tenant-session-value",
      "http://customer.internal.local/path?token=secret",
      "10.20.30.40",
    ].join(" | ");
    const scrubbed = scrubText(sensitive);

    expect(scrubbed).not.toContain("dXNlcjpzZWNyZXQ=");
    expect(scrubbed).not.toContain("tenant-session-value");
    expect(scrubbed).not.toContain("customer.internal.local");
    expect(scrubbed).not.toContain("10.20.30.40");
  });

  test("removes emails, home paths, and quoted tenant payloads", () => {
    const scrubbed = scrubText(
      `failure at ${homedir()}/.atlas/config.ini for {"name":"Budi","email":"budi@example.com"}`
    );

    expect(scrubbed).not.toContain(homedir());
    expect(scrubbed).not.toContain("Budi");
    expect(scrubbed).not.toContain("example.com");
    expect(scrubbed).toContain("~/.atlas/config.ini");
  });

  test("keeps single-quoted diagnostic identifiers readable", () => {
    expect(scrubText("Cannot find module 'error-tracking'")).toContain(
      "'error-tracking'"
    );
  });

  test("truncates runaway messages", () => {
    expect(scrubText("x".repeat(10_000)).length).toBeLessThanOrEqual(4001);
  });

  test("bounds work for deeply nested crash payloads", () => {
    const startedAt = performance.now();
    const scrubbed = scrubText(
      `${"[".repeat(100_000)}tenant-secret${"]".repeat(100_000)}`
    );

    expect(scrubbed).not.toContain("tenant-secret");
    expect(scrubbed.length).toBeLessThanOrEqual(4001);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
