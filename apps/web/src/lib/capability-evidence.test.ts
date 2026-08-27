import { describe, expect, test } from "bun:test";
import type { CapabilityCatalogResponse } from "@atlas/core/contract";
import {
  buildCapabilityEvidencePatch,
  capabilityEvidenceSelectionIsDisabled,
  capabilityEvidenceSelections,
  capabilityEvidenceSettingLabel,
  INHERIT_CAPABILITY_EVIDENCE,
  listProviderCapabilityEvidenceRows,
} from "./capability-evidence";

const catalog: CapabilityCatalogResponse = {
  capabilities: [
    {
      description: "Synthetic chat evidence.",
      id: "vendor.synthetic-chat",
      label: "Synthetic chat",
      routable: false,
    },
    {
      description: "Synthetic routed operation.",
      id: "vendor.synthetic-route",
      label: "Synthetic route",
      routable: true,
    },
  ],
  providers: [
    {
      capabilities: [
        {
          capabilityId: "vendor.synthetic-chat",
          implementationAvailable: true,
          nativeStatus: "unknown",
        },
        {
          capabilityId: "vendor.synthetic-route",
          implementationAvailable: true,
          nativeStatus: "supported",
        },
      ],
      displayName: "Synthetic",
      id: "synthetic",
      models: [],
    },
  ],
  schemaVersion: 1,
};

describe("provider capability evidence", () => {
  test("discovers a synthetic non-routable capability from catalog metadata", () => {
    expect(listProviderCapabilityEvidenceRows(catalog, "synthetic")).toEqual([
      {
        capabilityId: "vendor.synthetic-chat",
        implementationAvailable: true,
        label: "Synthetic chat",
      },
    ]);
  });

  test("shows the configured setting instead of provider-native evidence", () => {
    expect(capabilityEvidenceSettingLabel(INHERIT_CAPABILITY_EVIDENCE)).toBe(
      "Provider default"
    );
    expect(capabilityEvidenceSettingLabel("supported")).toBe("Supported");
    expect(capabilityEvidenceSettingLabel("unsupported")).toBe("Unsupported");
    expect(capabilityEvidenceSettingLabel("unknown")).toBe("Unknown");
  });

  test("cannot mark a capability supported when its Atlas adapter is unavailable", () => {
    const unavailableRow = {
      capabilityId: "vendor.synthetic-chat",
      implementationAvailable: false,
      label: "Synthetic chat",
    };

    expect(
      capabilityEvidenceSelectionIsDisabled(unavailableRow, "supported")
    ).toBe(true);
    expect(
      capabilityEvidenceSelectionIsDisabled(unavailableRow, "unsupported")
    ).toBe(false);
    expect(
      capabilityEvidenceSelectionIsDisabled(
        unavailableRow,
        INHERIT_CAPABILITY_EVIDENCE
      )
    ).toBe(false);
  });

  test("builds only changed overrides and uses null to restore adapter evidence", () => {
    const rows = listProviderCapabilityEvidenceRows(catalog, "synthetic");
    const instance = {
      capabilityOverrides: {
        "vendor.synthetic-chat": {
          source: "admin-override" as const,
          status: "supported" as const,
          verified: true,
        },
      },
      createdAt: "2026-08-27T00:00:00.000Z",
      hasApiKey: true,
      id: "synthetic-1",
      label: "Synthetic",
      modelCount: 1,
      type: "openai" as const,
    };
    const original = capabilityEvidenceSelections(rows, instance);

    expect(original).toEqual({ "vendor.synthetic-chat": "supported" });
    expect(
      buildCapabilityEvidencePatch(rows, original, {
        "vendor.synthetic-chat": INHERIT_CAPABILITY_EVIDENCE,
      })
    ).toEqual({ "vendor.synthetic-chat": null });
    expect(buildCapabilityEvidencePatch(rows, original, original)).toEqual({});
  });
});
