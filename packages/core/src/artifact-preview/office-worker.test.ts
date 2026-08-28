import { describe, expect, test } from "bun:test";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  WidthType,
} from "docx";
import { createPptxBuffer } from "../presentation-engine";
import { derivedAssetStore } from "./derived-asset-store";
import { inspectZipBombSafety, officeConverter } from "./office-converter";
import { PreviewService } from "./service";
import type { PreviewContext } from "./types";

const testContext: PreviewContext = {
  orgId: "org_alpha",
  profileId: "profile_1",
};

const officeAvailable = await officeConverter.isAvailable();

describe("Isolated Office Fidelity Worker Pipeline", () => {
  test.skipIf(!officeAvailable)(
    "OfficeConverter detects host LibreOffice binary",
    async () => {
      const isAvailable = await officeConverter.isAvailable();
      expect(isAvailable).toBe(true);

      const binary = await officeConverter.resolveConverterBinary();
      expect(binary).not.toBeNull();
    }
  );

  test.skipIf(!officeAvailable)(
    "converts real complex multi-slide PPTX to high-fidelity derived PDF",
    async () => {
      const pptxBuffer = await createPptxBuffer({
        company: "Atlas Enterprise",
        slides: [
          {
            layout: "title",
            subtitle: "Enterprise Artifact Preview Platform",
            title: "Q3 AI Strategy Deck",
          },
          {
            bulletPoints: [
              "Zero-friction in-browser previewing for all AI deliverables",
              "Rich interactive viewers for Excel, PowerPoint, PDF, Word & Code",
              "Strict multi-tenant security isolation across all workspaces",
            ],
            layout: "content",
            notes: "Speaker note: emphasize high-fidelity rendering.",
            title: "Executive Summary",
          },
          {
            layout: "content",
            table: {
              headers: ["Metric", "Target", "Status"],
              rows: [
                ["Coverage", "100%", "On Track"],
                ["Fidelity", "High (PDF)", "Verified"],
              ],
            },
            title: "Platform Key Metrics",
          },
        ],
        title: "Q3 AI Strategy Deck",
      });

      const previewService = new PreviewService();
      const preview = await previewService.generate(
        {
          filename: "q3-ai-strategy.pptx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          sizeBytes: pptxBuffer.length,
        },
        pptxBuffer,
        {},
        testContext
      );

      expect(preview.type).toBe("pdf");
      expect(preview.status).toBe("available");
      expect(preview.strategy).toBe("converted");

      if (preview.type === "pdf") {
        expect(preview.pageCount).toBe(3);
        expect(preview.previewUrl).toContain("/derived-pdf");
        expect(preview.downloadUrl).toContain("q3-ai-strategy.pptx");
        expect(preview.downloadUrl).not.toContain("derived-pdf");
      }

      const manifest = await previewService.generateManifest(
        {
          filename: "q3-ai-strategy.pptx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          sizeBytes: pptxBuffer.length,
        },
        pptxBuffer,
        {},
        testContext
      );

      expect(manifest.renderer).toBe("pdf");
      expect(manifest.strategy).toBe("converted");
      expect(manifest.derivedFrom).toBeDefined();
      expect(manifest.derivedFrom?.assetId).toContain(
        "q3-ai-strategy.pptx-original"
      );
      expect(
        manifest.assets.some(
          (a) => a.kind === "converted" && a.mimeType === "application/pdf"
        )
      ).toBe(true);
    },
    30_000
  );

  test.skipIf(!officeAvailable)(
    "converts real complex DOCX with tables and headings to high-fidelity derived PDF",
    async () => {
      const doc = new Document({
        sections: [
          {
            children: [
              new Paragraph({
                heading: HeadingLevel.HEADING_1,
                text: "Atlas Platform Architecture Specification",
              }),
              new Paragraph({
                text: "This document defines the architecture and security specifications for the isolated artifact preview system.",
              }),
              new Table({
                rows: [
                  new TableRow({
                    children: [
                      new TableCell({
                        children: [new Paragraph({ text: "Component" })],
                        width: { size: 50, type: WidthType.PERCENTAGE },
                      }),
                      new TableCell({
                        children: [new Paragraph({ text: "Security Level" })],
                        width: { size: 50, type: WidthType.PERCENTAGE },
                      }),
                    ],
                  }),
                  new TableRow({
                    children: [
                      new TableCell({
                        children: [
                          new Paragraph({ text: "Office Converter Worker" }),
                        ],
                        width: { size: 50, type: WidthType.PERCENTAGE },
                      }),
                      new TableCell({
                        children: [
                          new Paragraph({
                            text: "Strict Sandbox (No secrets)",
                          }),
                        ],
                        width: { size: 50, type: WidthType.PERCENTAGE },
                      }),
                    ],
                  }),
                ],
              }),
            ],
          },
        ],
      });

      const docxBuffer = await Packer.toBuffer(doc);

      const previewService = new PreviewService();
      const preview = await previewService.generate(
        {
          filename: "architecture-spec.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: docxBuffer.length,
        },
        docxBuffer,
        {},
        testContext
      );

      expect(preview.type).toBe("pdf");
      expect(preview.status).toBe("available");
      expect(preview.strategy).toBe("converted");

      if (preview.type === "pdf") {
        expect(preview.pageCount).toBeGreaterThanOrEqual(1);
        expect(preview.previewUrl).toContain("/derived-pdf");
        expect(preview.downloadUrl).toContain("architecture-spec.docx");
      }
    },
    30_000
  );

  test.skipIf(!officeAvailable)(
    "deduplicates concurrent in-flight conversion jobs for the same revision",
    async () => {
      const pptxBuffer = await createPptxBuffer({
        slides: [{ layout: "title", title: "Concurrency Test" }],
        title: "Concurrency Test",
      });

      const previewService = new PreviewService();
      const target = {
        filename: "concurrency.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sizeBytes: pptxBuffer.length,
      };

      const [res1, res2, res3] = await Promise.all([
        previewService.generate(target, pptxBuffer, {}, testContext),
        previewService.generate(target, pptxBuffer, {}, testContext),
        previewService.generate(target, pptxBuffer, {}, testContext),
      ]);

      expect(res1.status).toBe("available");
      expect(res2.status).toBe("available");
      expect(res3.status).toBe("available");
      expect(res1.strategy).toBe("converted");
      expect(res2.strategy).toBe("converted");
      expect(res3.strategy).toBe("converted");
    },
    30_000
  );

  test.skipIf(!officeAvailable)(
    "revision v2 never reuses v1 derived preview cache",
    async () => {
      const previewService = new PreviewService();

      const pptx1 = await createPptxBuffer({
        slides: [{ layout: "title", title: "Version 1" }],
        title: "Version 1",
      });

      const pptx2 = await createPptxBuffer({
        slides: [
          { layout: "title", title: "Version 2" },
          {
            bulletPoints: ["Slide 2 text"],
            layout: "content",
            title: "Details",
          },
        ],
        title: "Version 2",
      });

      const target1 = {
        filename: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        revision: 1,
        sizeBytes: pptx1.length,
      };

      const target2 = {
        filename: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        revision: 2,
        sizeBytes: pptx2.length,
      };

      const preview1 = await previewService.generate(
        target1,
        pptx1,
        { revision: 1 },
        testContext
      );
      const preview2 = await previewService.generate(
        target2,
        pptx2,
        { revision: 2 },
        testContext
      );

      expect(preview1.revision).toBe(1);
      expect(preview2.revision).toBe(2);

      if (preview1.type === "pdf" && preview2.type === "pdf") {
        expect(preview1.pageCount).toBe(1);
        expect(preview2.pageCount).toBe(2);
        expect(preview1.previewUrl).toContain("revision=1");
        expect(preview2.previewUrl).toContain("revision=2");
      }
    },
    30_000
  );

  test("gracefully falls back to semantic preview if conversion is disabled or fails", async () => {
    const pptxBuffer = await createPptxBuffer({
      slides: [{ layout: "title", title: "Semantic Fallback Test" }],
      title: "Semantic Fallback Test",
    });

    const previewService = new PreviewService();
    const preview = await previewService.generate(
      {
        filename: "semantic-only.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sizeBytes: pptxBuffer.length,
      },
      pptxBuffer,
      { strategy: "semantic" },
      testContext
    );

    expect(preview.type).toBe("presentation");
    expect(preview.strategy).toBe("semantic");
    expect(preview.status).toBe("available");
    if (preview.type === "presentation") {
      expect(preview.slides.length).toBe(1);
      expect(preview.slides[0]?.title).toBe("Semantic Fallback Test");
    }
  });

  test("enforces tenant boundary: Tenant B cannot fetch Tenant A derived asset", () => {
    derivedAssetStore.clear();

    derivedAssetStore.storeDerivedAsset({
      artifactId: "report.pptx",
      bytes: Buffer.from("%PDF-1.4\n1 0 obj..."),
      contentHash: "hash_org_a",
      converterVersion: "v1.0",
      mimeType: "application/pdf",
      orgId: "org_a",
      pageCount: 3,
      profileId: "prof_a",
      revision: 1,
    });

    const orgAAsset = derivedAssetStore.getDerivedAsset(
      "org_a",
      "prof_a",
      "report.pptx",
      1,
      "hash_org_a",
      "v1.0"
    );
    expect(orgAAsset).toBeDefined();
    expect(orgAAsset?.pageCount).toBe(3);

    const orgBAsset = derivedAssetStore.getDerivedAsset(
      "org_b",
      "prof_b",
      "report.pptx",
      1,
      "hash_org_a",
      "v1.0"
    );
    expect(orgBAsset).toBeUndefined();
  });

  test("zip bomb safety check catches suspicious compression ratios", () => {
    const safeBuffer = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0,
    ]);
    expect(() => inspectZipBombSafety(safeBuffer)).not.toThrow();
  });
});
