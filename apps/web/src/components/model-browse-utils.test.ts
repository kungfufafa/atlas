import { describe, expect, test } from "bun:test";
import { capabilityBrowseRowToModelListRow } from "@/components/model-browse-utils";
import { fireworksEntryToCapabilityRow } from "@/hooks/use-fireworks-discover-models";

describe("capabilityBrowseRowToModelListRow", () => {
  test("maps reasoning and vision flags from browse rows", () => {
    const row = fireworksEntryToCapabilityRow({
      contextWindow: 262_144,
      id: "accounts/fireworks/models/kimi-k2p5",
      inputPerMillionUsd: 0.6,
      name: "Kimi K2.5",
      outputPerMillionUsd: 2.5,
      supportsThinking: true,
      supportsVision: true,
    });

    expect(capabilityBrowseRowToModelListRow(row)).toEqual({
      contextWindow: 262_144,
      id: "accounts/fireworks/models/kimi-k2p5",
      inputPerMillionUsd: 0.6,
      name: "Kimi K2.5",
      outputPerMillionUsd: 2.5,
      supportsThinking: true,
      supportsVision: true,
    });
  });

  test("preserves generic discovered capability evidence", () => {
    const capabilities = {
      "vendor.image-operation": {
        source: "provider-discovery" as const,
        status: "supported" as const,
        verified: true,
      },
    };

    expect(
      capabilityBrowseRowToModelListRow({
        capabilities,
        id: "vendor/model",
        name: "Vendor model",
      }).capabilities
    ).toBe(capabilities);
  });
});
