import { expect, test } from "bun:test";
import {
  recoveryFixtureUrls,
  webFetchFixtureResponse,
} from "./web-fetch-fixture";

test("deterministic HTTP fixture is limited to exact fixture URLs and carries the run marker", async () => {
  const urls = recoveryFixtureUrls("123e4567-e89b-12d3-a456-426614174000");
  expect(webFetchFixtureResponse(new URL(urls.failure))?.status).toBe(503);
  const response = webFetchFixtureResponse(new URL(urls.success));
  expect(response?.status).toBe(200);
  expect(await response?.text()).toContain(
    "123e4567-e89b-12d3-a456-426614174000"
  );
  for (const url of [
    "https://example.com/1234",
    "http://alternative-source.atlas-gate.test/1234",
    "https://alternative-source.atlas-gate.test/not-a-run",
    `${urls.success}?another=request`,
  ]) {
    expect(webFetchFixtureResponse(new URL(url))).toBeUndefined();
  }
});
