export const PUBLIC_ROUTES = new Set([
  "/health",
  "/docs",
  "/docs/",
  "/openapi.json",
  "/v1/auth/setup",
  "/v1/auth/setup/import/preview",
  "/v1/auth/setup/import/restore",
  "/v1/auth/login",
  "/v1/auth/me",
  "/v1/auth/accept-invite",
  "/v1/composio/oauth/callback",
  "/v1/tasks/__capability_probe__/messages",
]);

const PUBLIC_POST_ONLY_ROUTES = new Set([
  "/v1/auth/setup",
  "/v1/auth/setup/import/preview",
  "/v1/auth/setup/import/restore",
  "/v1/auth/login",
  "/v1/auth/accept-invite",
]);

export function isPublicRouteRequest(
  method: string,
  pathname: string
): boolean {
  if (pathname === "/v1/auth/me") {
    return method === "GET";
  }

  if (pathname === "/v1/auth/invite") {
    return method === "GET";
  }

  if (pathname === "/v1/tasks/__capability_probe__/messages") {
    return method === "GET";
  }

  if (pathname === "/v1/composio/oauth/callback") {
    return method === "GET";
  }

  if (/^\/v1\/notify\/[^/]+$/.test(pathname)) {
    return method === "POST";
  }

  if (PUBLIC_POST_ONLY_ROUTES.has(pathname)) {
    return method === "POST";
  }

  return (
    PUBLIC_ROUTES.has(pathname) ||
    (method === "GET" &&
      /^\/v1\/public\/artifact-shares\/[^/]+(?:\/preview)?$/.test(pathname))
  );
}
