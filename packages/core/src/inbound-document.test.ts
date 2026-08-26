import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  sanitizeInboundDocumentFilename,
  saveInboundWorkspaceDocument,
  uniqueInboundDocumentFilename,
} from "./inbound-document";
import { withIsolatedAtlasHome } from "./testing/atlas-home";

describe("inbound workspace documents", () => {
  test("sanitizes path characters in filenames", () => {
    expect(sanitizeInboundDocumentFilename("../../sales.xlsx")).toBe(
      "sales.xlsx"
    );
    expect(sanitizeInboundDocumentFilename("rekap penjualan (1).xlsx")).toBe(
      "rekap penjualan (1).xlsx"
    );
    expect(sanitizeInboundDocumentFilename("a/b\\c*.xlsx")).toBe("c_.xlsx");
    expect(sanitizeInboundDocumentFilename(".")).toBe("document");
    expect(sanitizeInboundDocumentFilename("..")).toBe("document");
    expect(sanitizeInboundDocumentFilename("../..")).toBe("document");
  });

  test("picks a unique filename when the original already exists", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-inbound-"));

    try {
      await writeFile(path.join(directory, "sales.xlsx"), "one");
      await expect(
        uniqueInboundDocumentFilename(directory, "sales.xlsx")
      ).resolves.toBe("sales-2.xlsx");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("writes the file under the profile artifacts directory", async () => {
    await withIsolatedAtlasHome("atlas-inbound-home-", async () => {
      const saved = await saveInboundWorkspaceDocument({
        bytes: Buffer.from("xlsx-bytes"),
        filename: "sales.xlsx",
        orgId: "org_test",
        profileId: "default",
      });

      expect(saved).toEqual({
        relativePath: "artifacts/sales.xlsx",
        sizeBytes: 10,
      });

      const written = await Bun.file(
        path.join(
          process.env.ATLAS_CONFIG_DIR ?? "",
          "orgs",
          "org_test",
          "profiles",
          "default",
          "artifacts",
          "sales.xlsx"
        )
      ).text();
      expect(written).toBe("xlsx-bytes");
    });
  });

  test("does not write reserved filenames outside artifacts", async () => {
    await withIsolatedAtlasHome("atlas-inbound-reserved-", async () => {
      const saved = await saveInboundWorkspaceDocument({
        bytes: Buffer.from("safe"),
        filename: "..",
        orgId: "org_test",
        profileId: "default",
      });

      expect(saved.relativePath).toBe("artifacts/document");

      const written = await Bun.file(
        path.join(
          process.env.ATLAS_CONFIG_DIR ?? "",
          "orgs",
          "org_test",
          "profiles",
          "default",
          "artifacts",
          "document"
        )
      ).text();
      expect(written).toBe("safe");
    });
  });
});
