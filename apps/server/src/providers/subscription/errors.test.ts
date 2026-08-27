import { describe, expect, test } from "bun:test";
import { classifySubscriptionError } from "./errors";

describe("classifySubscriptionError", () => {
  test("maps quota and plan limits separately from rate limits", () => {
    expect(classifySubscriptionError("plan limit reached")).toBe(
      "subscription_limit_reached"
    );
    expect(classifySubscriptionError("HTTP 429 too many requests")).toBe(
      "rate_limited"
    );
  });

  test("maps auth, model, and missing runtime failures", () => {
    expect(classifySubscriptionError("401 unauthenticated")).toBe(
      "authentication_expired"
    );
    expect(classifySubscriptionError("unknown model gpt-x")).toBe(
      "model_unavailable"
    );
    expect(classifySubscriptionError("codex: ENOENT")).toBe(
      "provider_unavailable"
    );
  });
});
