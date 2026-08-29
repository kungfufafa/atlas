import { expect, test } from "bun:test";
import { AtlasApiError } from "@atlas/client";
import { isInvalidSessionError } from "./session-auth";

test("only treats an unauthorized API response as an invalid session", () => {
  expect(isInvalidSessionError(new AtlasApiError("Unauthorized", 401))).toBe(
    true
  );
  expect(isInvalidSessionError(new AtlasApiError("Unavailable", 503))).toBe(
    false
  );
  expect(isInvalidSessionError(new Error("Failed to fetch"))).toBe(false);
});
