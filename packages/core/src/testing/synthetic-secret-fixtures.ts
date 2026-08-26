const OPAQUE_FIXTURE_BODY = "ATLASTESTFIXTURE00000000000000000000";

const withPrefix = (prefix: string, body = OPAQUE_FIXTURE_BODY): string =>
  `${prefix}${body}`;

const buildPemFixture = (keyType?: "RSA"): string => {
  const label = keyType ? `${keyType} PRIVATE KEY-----` : "PRIVATE KEY-----";
  const header = ["-----BEGIN", label].join(" ");
  const footer = ["-----END", label].join(" ");
  return [header, "ATLAS_SYNTHETIC_PRIVATE_KEY_MATERIAL", footer].join("\n");
};

/**
 * Credential-shaped values for redaction and leak-detection tests only.
 *
 * They are assembled from non-credential fragments so the repository scanner
 * can stay fail-closed for every supported literal secret shape, including in
 * test and cassette files. Add a named value here instead of weakening scanner
 * rules.
 */
export const SYNTHETIC_SECRET_FIXTURES = Object.freeze({
  anthropicApiKey: withPrefix("sk-ant-api03-"),
  awsAccessKeyId: withPrefix("AKIA", "ATLASFIXTURE0001"),
  bearerPayload: OPAQUE_FIXTURE_BODY,
  bearerToken: ["Bearer", OPAQUE_FIXTURE_BODY].join(" "),
  databaseUri: [
    "postgresql",
    "://atlas_fixture:ATLAS_FIXTURE_PASSWORD@db.invalid:5432/atlas",
  ].join(""),
  githubAccessToken: withPrefix("ghp_"),
  openAiApiKey: withPrefix("sk-"),
  openAiProjectApiKey: withPrefix("sk-proj-"),
  privateKey: buildPemFixture(),
  rsaPrivateKey: buildPemFixture("RSA"),
  slackAccessToken: [
    "xoxb",
    "1234567890",
    "0987654321",
    OPAQUE_FIXTURE_BODY,
  ].join("-"),
  tokenRouterApiKey: withPrefix("tokenrouter-"),
});
