const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function validateComposioOAuthRedirect(redirectUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    throw new Error("Composio returned an invalid OAuth URL.");
  }
  const secure = parsed.protocol === "https:";
  const localDevelopment =
    parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  if (!(secure || localDevelopment) || parsed.username || parsed.password) {
    throw new Error("Composio returned an unsafe OAuth URL.");
  }
  return parsed.toString();
}
