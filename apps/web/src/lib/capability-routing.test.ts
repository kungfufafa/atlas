import { describe, expect, test } from "bun:test";
import {
  buildCapabilityBinding,
  capabilityBindingSelections,
  DISABLED_CAPABILITY_SELECTION,
  decodeCapabilityTarget,
  encodeCapabilityTarget,
  NO_PRIMARY_CAPABILITY_SELECTION,
} from "./capability-routing";

describe("capability routing form helpers", () => {
  test("round-trips provider and model ids without delimiter assumptions", () => {
    const target = {
      modelId: "vendor/model::preview",
      providerId: "provider:id/one",
    };

    expect(decodeCapabilityTarget(encodeCapabilityTarget(target))).toEqual(
      target
    );
  });

  test("builds an ordered, deduplicated manual fallback route", () => {
    const primary = encodeCapabilityTarget({
      modelId: "primary",
      providerId: "provider-a",
    });
    const fallback = encodeCapabilityTarget({
      modelId: "fallback",
      providerId: "provider-b",
    });

    expect(
      buildCapabilityBinding(primary, [fallback, primary, fallback])
    ).toEqual({
      contractVersion: 1,
      enabled: true,
      fallbacks: [{ modelId: "fallback", providerId: "provider-b" }],
      mode: "manual",
      primary: { modelId: "primary", providerId: "provider-a" },
    });
  });

  test("represents an unconfigured capability explicitly", () => {
    expect(buildCapabilityBinding(DISABLED_CAPABILITY_SELECTION, [])).toEqual({
      contractVersion: 1,
      enabled: false,
      fallbacks: [],
      mode: "manual",
    });
    expect(capabilityBindingSelections(undefined)).toEqual({
      fallbacks: [],
      primary: DISABLED_CAPABILITY_SELECTION,
    });
  });

  test("round-trips an enabled fallback-only route without disabling it", () => {
    const fallbackTarget = {
      modelId: "fallback-only",
      providerId: "provider-b",
    };
    const binding = {
      contractVersion: 1 as const,
      enabled: true,
      fallbacks: [fallbackTarget],
      mode: "manual" as const,
    };

    expect(capabilityBindingSelections(binding)).toEqual({
      fallbacks: [encodeCapabilityTarget(fallbackTarget)],
      primary: NO_PRIMARY_CAPABILITY_SELECTION,
    });
    expect(
      buildCapabilityBinding(NO_PRIMARY_CAPABILITY_SELECTION, [
        encodeCapabilityTarget(fallbackTarget),
      ])
    ).toEqual(binding);
  });
});
