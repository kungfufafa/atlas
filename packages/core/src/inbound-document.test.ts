import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

  test("enforces a profile storage quota before writing", async () => {
    await withIsolatedAtlasHome("atlas-inbound-quota-", async () => {
      await saveInboundWorkspaceDocument({
        bytes: Buffer.from("12345"),
        filename: "first.txt",
        maxStoredBytes: 8,
        orgId: "org_test",
        profileId: "default",
      });

      await expect(
        saveInboundWorkspaceDocument({
          bytes: Buffer.from("6789"),
          filename: "second.txt",
          maxStoredBytes: 8,
          orgId: "org_test",
          profileId: "default",
        })
      ).rejects.toThrow("storage quota exceeded");
    });
  });

  test("serializes concurrent filename allocation", async () => {
    await withIsolatedAtlasHome("atlas-inbound-concurrent-", async () => {
      const saved = await Promise.all(
        ["one", "two"].map((content) =>
          saveInboundWorkspaceDocument({
            bytes: Buffer.from(content),
            filename: "report.txt",
            orgId: "org_test",
            profileId: "default",
          })
        )
      );

      expect(saved.map((entry) => entry.relativePath).sort()).toEqual([
        "artifacts/report-2.txt",
        "artifacts/report.txt",
      ]);
    });
  });

  test("refuses a symlinked artifacts directory", async () => {
    await withIsolatedAtlasHome("atlas-inbound-symlink-", async () => {
      const atlasHome = process.env.ATLAS_CONFIG_DIR ?? "";
      const profileDir = path.join(
        atlasHome,
        "orgs",
        "org_test",
        "profiles",
        "default"
      );
      const outside = await mkdtemp(path.join(os.tmpdir(), "atlas-outside-"));
      await mkdir(profileDir, { recursive: true });
      await symlink(outside, path.join(profileDir, "artifacts"));

      try {
        await expect(
          saveInboundWorkspaceDocument({
            bytes: Buffer.from("secret"),
            filename: "report.txt",
            orgId: "org_test",
            profileId: "default",
          })
        ).rejects.toThrow("must be a real directory");
        expect(await Bun.file(path.join(outside, "report.txt")).exists()).toBe(
          false
        );
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    });
  });
});
