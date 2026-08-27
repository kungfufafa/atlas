import { describe, expect, test } from "bun:test";
import {
  mergeCatalogModelsIntoRows,
  shouldShowCatalogModelBrowser,
} from "./catalog-provider-model-fields.shared";

describe("shouldShowCatalogModelBrowser", () => {
  test("opens the catalog instead of rendering an empty model editor", () => {
    expect(
      shouldShowCatalogModelBrowser({ customModelCount: 0, isBrowsing: false })
    ).toBe(true);
  });

  test("keeps configured models in the editor until Browse is requested", () => {
    expect(
      shouldShowCatalogModelBrowser({ customModelCount: 1, isBrowsing: false })
    ).toBe(false);
    expect(
      shouldShowCatalogModelBrowser({ customModelCount: 1, isBrowsing: true })
    ).toBe(true);
  });
});

describe("mergeCatalogModelsIntoRows", () => {
  test("deduplicates by id while preserving manual rows and their defaults", () => {
    expect(
      mergeCatalogModelsIntoRows(
        [
          {
            default: true,
            id: "manual/model",
            name: "My label",
            supportsVision: false,
          },
          { id: "manual/model", name: "Duplicate" },
        ],
        [
          {
            id: "manual/model",
            name: "Catalog label",
            provider: "openai",
            supportsVision: true,
          },
          {
            capabilities: {
              "vendor.custom-operation": {
                source: "provider-discovery",
                status: "supported",
              },
            },
            id: "catalog/model",
            inputPerMillionUsd: 1,
            name: "Catalog model",
            provider: "openai",
            reasoningEffortValues: ["low", "high"],
            supportsThinking: true,
            supportsVision: true,
          },
        ]
      )
    ).toEqual([
      {
        default: true,
        id: "manual/model",
        name: "My label",
        supportsVision: false,
      },
      {
        capabilities: {
          "vendor.custom-operation": {
            source: "provider-discovery",
            status: "supported",
          },
        },
        id: "catalog/model",
        inputPerMillionUsd: 1,
        name: "Catalog model",
        reasoningEffortValues: ["low", "high"],
        supportsThinking: true,
        supportsVision: true,
      },
    ]);
  });

  test("keeps only the first existing default when catalog defaults are added", () => {
    const merged = mergeCatalogModelsIntoRows(
      [
        { default: true, id: "manual", name: "Manual" },
        { default: true, id: "duplicate-default", name: "Duplicate" },
      ],
      [
        {
          default: true,
          id: "catalog-default",
          name: "Catalog default",
          provider: "openai",
        },
      ]
    );

    expect(merged.filter((row) => row.default)).toEqual([
      { default: true, id: "manual", name: "Manual" },
    ]);
  });

  test("does not let a blank placeholder consume the catalog default", () => {
    expect(
      mergeCatalogModelsIntoRows(
        [{ default: true, id: "", name: "" }],
        [
          {
            default: true,
            id: "catalog-default",
            name: "Catalog default",
            provider: "openai",
          },
        ]
      )
    ).toEqual([
      { id: "", name: "" },
      {
        default: true,
        id: "catalog-default",
        name: "Catalog default",
      },
    ]);
  });
});
