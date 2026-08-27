import { describe, expect, test } from "bun:test";
import {
  resolveProviderSettingsError,
  resolveProviderSettingsLoadingState,
} from "./ProviderSettingsCard";

describe("provider settings state", () => {
  test("keeps provider recovery controls visible while models load", () => {
    expect(
      resolveProviderSettingsLoadingState({
        catalogLoading: true,
        providersLoading: false,
      })
    ).toEqual({ catalogActionsDisabled: true, showSkeleton: false });
    expect(
      resolveProviderSettingsLoadingState({
        catalogLoading: false,
        providersLoading: true,
      }).showSkeleton
    ).toBe(true);
  });

  test("gives a catalog failure one alert owner while setup is visible", () => {
    expect(
      resolveProviderSettingsError({
        catalogError: "Could not load models.",
        formError: null,
        setupFormVisible: false,
      })
    ).toBe("Could not load models.");
    expect(
      resolveProviderSettingsError({
        catalogError: "Could not load models.",
        formError: null,
        setupFormVisible: true,
      })
    ).toBeNull();
    expect(
      resolveProviderSettingsError({
        catalogError: "Could not load models.",
        formError: "Provider update failed.",
        setupFormVisible: true,
      })
    ).toBe("Provider update failed.");
  });
});
