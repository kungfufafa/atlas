import { expect, test } from "bun:test";
import { AUTOMATION_POLL_INTERVAL_MS } from "./config";

test("automation poll defaults to five minutes", () => {
  expect(AUTOMATION_POLL_INTERVAL_MS).toBe(300_000);
});
