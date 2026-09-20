import { mock } from "bun:test";
import type { LookupOptions } from "node:dns";
import * as dns from "node:dns/promises";
import {
  WEB_FETCH_FIXTURE_HOSTS,
  webFetchFixtureResponse,
} from "./web-fetch-fixture";

if (process.env.ATLAS_ENV !== "e2e") {
  throw new Error(
    "Release-gate network fixtures require the isolated e2e environment."
  );
}

// Only the two deterministic fixture hosts are substituted. Atlas's real
// web_fetch validation, HTTP failure handling and tool loop still execute.
const originalLookup = dns.lookup;
mock.module("node:dns/promises", () => ({
  ...dns,
  lookup: (hostname: string, options: LookupOptions = {}) =>
    WEB_FETCH_FIXTURE_HOSTS.has(hostname)
      ? Promise.resolve([{ address: "93.184.216.34", family: 4 }])
      : originalLookup(hostname, options),
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString()
    );
    const fixture = webFetchFixtureResponse(url);
    return fixture ? Promise.resolve(fixture) : originalFetch(input, init);
  },
  originalFetch
);
