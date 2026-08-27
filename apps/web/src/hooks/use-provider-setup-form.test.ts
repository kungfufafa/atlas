import { describe, expect, test } from "bun:test";
import { AtlasApiError } from "@atlas/core/api-error";
import type { ProviderModelOption } from "@atlas/core/contract";
import {
  getSubscriptionModelSelectionIssue,
  isProviderSetupOperationCurrent,
  providerSetupFailureFocusId,
  reconcileTrackedSubscriptionIssue,
  resolveAutomaticProviderModelSelection,
  subscriptionModelErrorRequiresAuthRefresh,
} from "./use-provider-setup-form";

const models = [{ id: "model-a" }, { id: "model-b" }];
const subscriptionModels: ProviderModelOption[] = [
  {
    default: true,
    id: "model-a",
    name: "Model A",
    provider: "chatgpt",
  },
  { id: "model-b", name: "Model B", provider: "chatgpt" },
];

describe("subscription model selection", () => {
  test("requires subscription authentication before model validation", () => {
    expect(
      getSubscriptionModelSelectionIssue({
        authenticated: false,
        loadFailed: false,
        loading: false,
        models,
        selectedModel: "model-a",
      })
    ).toBe("not-authenticated");
  });

  test("reports model loading and load failures", () => {
    expect(
      getSubscriptionModelSelectionIssue({
        authenticated: true,
        loadFailed: false,
        loading: true,
        models: [],
        selectedModel: "",
      })
    ).toBe("loading");
    expect(
      getSubscriptionModelSelectionIssue({
        authenticated: true,
        loadFailed: true,
        loading: false,
        models,
        selectedModel: "model-a",
      })
    ).toBe("load-failed");
  });

  test("rejects empty catalogs and stale selections", () => {
    expect(
      getSubscriptionModelSelectionIssue({
        authenticated: true,
        loadFailed: false,
        loading: false,
        models: [],
        selectedModel: "",
      })
    ).toBe("no-models");
    expect(
      getSubscriptionModelSelectionIssue({
        authenticated: true,
        loadFailed: false,
        loading: false,
        models,
        selectedModel: "removed-model",
      })
    ).toBe("invalid-model");
  });

  test("accepts a model returned by the authenticated runtime", () => {
    expect(
      getSubscriptionModelSelectionIssue({
        authenticated: true,
        loadFailed: false,
        loading: false,
        models,
        selectedModel: "model-b",
      })
    ).toBeNull();
  });

  test("tracks a surfaced transient issue until model selection recovers", () => {
    expect(reconcileTrackedSubscriptionIssue(null, "loading")).toBeNull();
    expect(reconcileTrackedSubscriptionIssue("loading", "invalid-model")).toBe(
      "invalid-model"
    );
    expect(reconcileTrackedSubscriptionIssue("invalid-model", null)).toBeNull();
  });

  test("replaces stale runtime models and preserves valid user selection", () => {
    expect(
      resolveAutomaticProviderModelSelection({
        currentModel: "removed-model",
        models: subscriptionModels,
        provider: "chatgpt",
        subscriptionProvider: true,
        subscriptionReady: true,
      })
    ).toBe("model-a");
    expect(
      resolveAutomaticProviderModelSelection({
        currentModel: "model-b",
        models: subscriptionModels,
        provider: "chatgpt",
        subscriptionProvider: true,
        subscriptionReady: true,
      })
    ).toBe("model-b");
    expect(
      resolveAutomaticProviderModelSelection({
        currentModel: "model-b",
        models: subscriptionModels,
        provider: "chatgpt",
        subscriptionProvider: true,
        subscriptionReady: false,
      })
    ).toBe("");
  });

  test("focuses a control that exists after provider save failures", () => {
    expect(providerSetupFailureFocusId("chatgpt")).toBe("model");
    expect(providerSetupFailureFocusId("claude")).toBe("model");
    expect(providerSetupFailureFocusId("openai")).toBe("api-key");
  });

  test("invalidates deferred provider operations across workspace changes", () => {
    expect(
      isProviderSetupOperationCurrent({
        currentGeneration: 3,
        currentOrgId: "org-b",
        operationGeneration: 3,
        operationOrgId: "org-a",
      })
    ).toBe(false);
    expect(
      isProviderSetupOperationCurrent({
        currentGeneration: 3,
        currentOrgId: "org-a",
        operationGeneration: 3,
        operationOrgId: "org-a",
      })
    ).toBe(true);
  });

  test("refreshes auth only for authentication-expired model failures", () => {
    expect(
      subscriptionModelErrorRequiresAuthRefresh(
        new AtlasApiError("Authentication expired.", 409)
      )
    ).toBe(true);
    expect(
      subscriptionModelErrorRequiresAuthRefresh(
        new AtlasApiError("Runtime unavailable.", 503)
      )
    ).toBe(false);
    expect(subscriptionModelErrorRequiresAuthRefresh(new Error("failed"))).toBe(
      false
    );
  });
});
