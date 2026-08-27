import { describe, expect, test } from "bun:test";
import {
  providerSetupActionsDisabled,
  providerSetupVisibleFormError,
  subscriptionModelErrorDescriptionId,
} from "./ProviderSetupForm";

describe("provider setup accessibility", () => {
  test("associates a surfaced subscription model error with its live region", () => {
    const subscriptionError = "Select an available subscription model.";

    expect(
      subscriptionModelErrorDescriptionId({
        formError: subscriptionError,
        formErrorId: "form-error",
        subscriptionModelError: subscriptionError,
        testError: null,
        testErrorId: "test-error",
      })
    ).toBe("form-error");
    expect(
      subscriptionModelErrorDescriptionId({
        formError: null,
        formErrorId: "form-error",
        subscriptionModelError: subscriptionError,
        testError: subscriptionError,
        testErrorId: "test-error",
      })
    ).toBe("test-error");
    expect(
      subscriptionModelErrorDescriptionId({
        formError: null,
        formErrorId: "form-error",
        subscriptionModelError: subscriptionError,
        testError: null,
        testErrorId: "test-error",
      })
    ).toBeUndefined();
  });

  test("blocks setup actions while subscription models are not authoritative", () => {
    expect(
      providerSetupActionsDisabled({
        busy: false,
        credentialReady: true,
        subscriptionBlocked: true,
        testingConnection: false,
      })
    ).toBe(true);
    expect(
      providerSetupActionsDisabled({
        busy: false,
        credentialReady: true,
        subscriptionBlocked: false,
        testingConnection: false,
      })
    ).toBe(false);
  });

  test("derives catalog errors so recovery removes stale alerts", () => {
    expect(providerSetupVisibleFormError(null, "Could not load models.")).toBe(
      "Could not load models."
    );
    expect(providerSetupVisibleFormError(null, null)).toBeNull();
    expect(
      providerSetupVisibleFormError(
        "Provider save failed.",
        "Could not load models."
      )
    ).toBe("Provider save failed.");
  });
});
