/** Test-only network inputs; these never represent live external source evidence. */
export const WEB_FETCH_FIXTURE_HOSTS = new Set([
  "broken-source.atlas-gate.test",
  "alternative-source.atlas-gate.test",
]);

export function recoveryFixtureUrls(runId: string): {
  failure: string;
  success: string;
} {
  return {
    failure: `https://broken-source.atlas-gate.test/${runId}`,
    success: `https://alternative-source.atlas-gate.test/${runId}`,
  };
}

export function webFetchFixtureResponse(url: URL): Response | undefined {
  if (
    url.protocol !== "https:" ||
    !WEB_FETCH_FIXTURE_HOSTS.has(url.hostname) ||
    !/^\/[a-f0-9-]+$/i.test(url.pathname) ||
    url.search ||
    url.port
  ) {
    return;
  }
  if (url.hostname === "broken-source.atlas-gate.test") {
    return new Response("Controlled release-gate source failure", {
      status: 503,
      statusText: "Service Unavailable",
    });
  }
  return new Response(`Recovered fixture data for ${url.pathname.slice(1)}`, {
    headers: { "content-type": "text/plain" },
  });
}
