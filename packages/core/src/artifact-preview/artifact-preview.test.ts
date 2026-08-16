import { describe, expect, test } from "bun:test";
import { createPptxBuffer } from "../presentation-engine";
import { defaultPreviewRegistry } from "./registry";
import { MAX_PREVIEW_FILE_SIZE_BYTES, PreviewService } from "./service";
import type { PreviewContext } from "./types";

const testContext: PreviewContext = {
  orgId: "org_test",
  profileId: "profile_1",
};

describe("Artifact Preview Platform - Core Engine", () => {
  describe("PdfPreviewer", () => {
    test("detects PDF support and extracts page count", async () => {
      const pdfBytes = Buffer.from(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n3 0 obj\n<< /Type /Page >>\nendobj\n4 0 obj\n<< /Type /Page >>\nendobj\nxref\ntrailer\n<< /Root 1 0 R >>\n%%EOF"
      );

      const previewer = defaultPreviewRegistry.findPreviewer({
        filename: "quarterly-report.pdf",
        mimeType: "application/pdf",
      });

      expect(previewer.type).toBe("pdf");
      const metadata = await previewer.inspect(
        {
          filename: "quarterly-report.pdf",
          mimeType: "application/pdf",
          sizeBytes: pdfBytes.length,
        },
        pdfBytes,
        testContext
      );
      expect(metadata.type).toBe("pdf");
      expect(metadata.metadata.pageCount).toBe(2);

      const preview = await previewer.generate(
        {
          filename: "quarterly-report.pdf",
          mimeType: "application/pdf",
          sizeBytes: pdfBytes.length,
        },
        pdfBytes,
        {},
        testContext
      );

      expect(preview.type).toBe("pdf");
      if (preview.type === "pdf") {
        expect(preview.pageCount).toBe(2);
        expect(preview.previewUrl).toContain("inline=1");
        expect(preview.status).toBe("available");
      }
    });
  });

  describe("SpreadsheetPreviewer", () => {
    test("parses CSV files into grid with auto-detected delimiter and types", async () => {
      const csvContent =
        "Item,Price,InStock,Quantity\nLaptop,$1200,true,15\nPhone,$800,false,0\nTablet,$400,true,25";
      const csvBuffer = Buffer.from(csvContent, "utf8");

      const previewer = defaultPreviewRegistry.findPreviewer({
        filename: "inventory.csv",
        mimeType: "text/csv",
      });

      expect(previewer.type).toBe("spreadsheet");
      const preview = await previewer.generate(
        {
          filename: "inventory.csv",
          mimeType: "text/csv",
          sizeBytes: csvBuffer.length,
        },
        csvBuffer,
        {},
        testContext
      );

      expect(preview.type).toBe("spreadsheet");
      if (preview.type === "spreadsheet") {
        expect(preview.totalSheets).toBe(1);
        expect(preview.activeSheet.name).toBe("Sheet1");
        expect(preview.activeSheet.rowCount).toBe(4);
        expect(preview.activeSheet.columnCount).toBe(4);
        expect(preview.activeSheet.headers).toEqual([
          "Item",
          "Price",
          "InStock",
          "Quantity",
        ]);
        expect(preview.activeSheet.data[1][0]).toBe("Laptop");
        expect(preview.activeSheet.data[1][2]).toBe(true);
        expect(preview.activeSheet.data[1][3]).toBe(15);
      }
    });

    test("parses XLSX buffer with formatted cells and multiple sheets", async () => {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws1 = wb.addWorksheet("Summary");
      ws1.addRow(["Metric", "Value"]);
      ws1.addRow(["Total Revenue", 150_000]);
      ws1.getCell("A1").font = { bold: true };
      ws1.getCell("B2").numFmt = "$#,##0.00";

      const ws2 = wb.addWorksheet("Details");
      ws2.addRow(["ID", "Name", "Date"]);
      ws2.addRow([1, "Atlas Project", "2026-08-16"]);

      const buffer = (await wb.xlsx.writeBuffer()) as Buffer;
      const previewer = defaultPreviewRegistry.findPreviewer({
        filename: "financials.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      expect(previewer.type).toBe("spreadsheet");
      const preview = await previewer.generate(
        {
          filename: "financials.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: buffer.length,
        },
        buffer,
        {},
        testContext
      );

      expect(preview.type).toBe("spreadsheet");
      if (preview.type === "spreadsheet") {
        expect(preview.totalSheets).toBe(2);
        expect(preview.sheetNames).toEqual(["Summary", "Details"]);
        expect(preview.activeSheet.name).toBe("Summary");
        expect(preview.activeSheet.data[0][0]).toBe("Metric");
        expect(preview.activeSheet.cellFormats?.["0:0"]?.bold).toBe(true);
        expect(preview.activeSheet.cellFormats?.["1:1"]?.type).toBe("currency");
      }

      // Switch to sheet 2
      const sheet2Preview = await previewer.generate(
        {
          filename: "financials.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: buffer.length,
        },
        buffer,
        { sheet: "Details" },
        testContext
      );
      if (sheet2Preview.type === "spreadsheet") {
        expect(sheet2Preview.activeSheet.name).toBe("Details");
        expect(sheet2Preview.activeSheetIndex).toBe(1);
        expect(sheet2Preview.activeSheet.data[1][1]).toBe("Atlas Project");
      }
    });
  });

  describe("PresentationPreviewer", () => {
    test("parses PPTX presentations and extracts structured slide models", async () => {
      const pptxBuffer = await createPptxBuffer({
        company: "Atlas Org",
        slides: [
          {
            layout: "title",
            subtitle: "Strategic Overview",
            title: "Q3 AI Strategy",
          },
          {
            bulletPoints: [
              "Launch Artifact Preview Platform",
              "Deliver Excel, PDF, PPTX rich viewers",
              "Enforce multi-tenant security isolation",
            ],
            layout: "content",
            notes: "Explain the product impact for each deliverable.",
            title: "Key Objectives",
          },
          {
            layout: "content",
            table: {
              headers: ["Phase", "Target", "Status"],
              rows: [
                ["Phase 1", "Core Architecture", "Done"],
                ["Phase 2", "Rich Viewers", "Active"],
              ],
            },
            title: "Implementation Phases",
          },
        ],
        title: "Q3 AI Strategy",
      });

      const previewer = defaultPreviewRegistry.findPreviewer({
        filename: "strategy.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      });

      expect(previewer.type).toBe("presentation");

      const inspectMeta = await previewer.inspect(
        {
          filename: "strategy.pptx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          sizeBytes: pptxBuffer.length,
        },
        pptxBuffer,
        testContext
      );
      expect(inspectMeta.metadata.slideCount).toBe(3);

      const preview = await previewer.generate(
        {
          filename: "strategy.pptx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          sizeBytes: pptxBuffer.length,
        },
        pptxBuffer,
        {},
        testContext
      );

      expect(preview.type).toBe("presentation");
      if (preview.type === "presentation") {
        expect(preview.slideCount).toBe(3);
        expect(preview.slides[0].title).toBe("Q3 AI Strategy");
        expect(preview.slides[0].subtitle).toBe("Strategic Overview");

        expect(preview.slides[1].title).toBe("Key Objectives");
        expect(preview.slides[1].bulletPoints?.length).toBe(3);
        expect(preview.slides[1].bulletPoints?.[0]).toContain(
          "Artifact Preview"
        );
        expect(preview.slides[1].notes).toContain("Explain the product impact");

        expect(preview.slides[2].title).toBe("Implementation Phases");
        expect(preview.slides[2].table?.headers).toEqual([
          "Phase",
          "Target",
          "Status",
        ]);
        expect(preview.slides[2].table?.rows.length).toBe(2);
      }
    });
  });

  describe("DocumentPreviewer", () => {
    test("extracts markdown and headings from Word documents", async () => {
      const docxText =
        "# Project Plan\n\n## Overview\nAtlas enables agentic workflows.\n\n## Architecture\nModular multi-tenant design.\n";
      const buffer = Buffer.from(docxText, "utf8");

      const previewer = defaultPreviewRegistry.findPreviewer({
        filename: "plan.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });

      expect(previewer.type).toBe("document");
      const preview = await previewer.generate(
        {
          filename: "plan.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: buffer.length,
        },
        buffer,
        {},
        testContext
      );

      expect(preview.type).toBe("document");
      if (preview.type === "document") {
        expect(preview.title).toBe("Project Plan");
        expect(preview.headings?.length).toBe(3);
        expect(preview.headings?.[0].text).toBe("Project Plan");
        expect(preview.headings?.[1].text).toBe("Overview");
        expect(preview.wordCount).toBeGreaterThan(5);
      }
    });
  });

  describe("ImagePreviewer", () => {
    test("extracts PNG dimensions and sanitizes SVG", async () => {
      // 100x50 PNG sample header
      const pngBuffer = Buffer.alloc(32);
      pngBuffer.write("\x89PNG\r\n\x1a\n", 0, "binary");
      pngBuffer.writeUInt32BE(13, 8); // chunk len
      pngBuffer.write("IHDR", 12, "binary");
      pngBuffer.writeUInt32BE(100, 16); // width
      pngBuffer.writeUInt32BE(50, 20); // height

      const imagePreviewer = defaultPreviewRegistry.findPreviewer({
        filename: "banner.png",
        mimeType: "image/png",
      });
      expect(imagePreviewer.type).toBe("image");

      const preview = await imagePreviewer.generate(
        {
          filename: "banner.png",
          mimeType: "image/png",
          sizeBytes: pngBuffer.length,
        },
        pngBuffer,
        {},
        testContext
      );

      if (preview.type === "image") {
        expect(preview.width).toBe(100);
        expect(preview.height).toBe(50);
        expect(preview.dimensions).toBe("100 × 50");
      }
    });
  });

  describe("CodePreviewer, MarkdownPreviewer, JsonPreviewer, TextPreviewer", () => {
    test("handles code languages and line bounds", async () => {
      const code =
        'import express from "express";\nconst app = express();\napp.listen(3000);';
      const buffer = Buffer.from(code, "utf8");

      const previewer = defaultPreviewRegistry.findPreviewer({
        filename: "server.ts",
        mimeType: "text/plain",
      });

      expect(previewer.type).toBe("code");
      const preview = await previewer.generate(
        {
          filename: "server.ts",
          mimeType: "text/plain",
          sizeBytes: buffer.length,
        },
        buffer,
        {},
        testContext
      );

      if (preview.type === "code") {
        expect(preview.language).toBe("typescript");
        expect(preview.lineCount).toBe(3);
        expect(preview.content).toBe(code);
      }
    });

    test("handles JSON formatting and object key inspection", async () => {
      const jsonStr =
        '{"status":"ok","users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]}';
      const buffer = Buffer.from(jsonStr, "utf8");

      const previewer = defaultPreviewRegistry.findPreviewer({
        filename: "response.json",
        mimeType: "application/json",
      });

      expect(previewer.type).toBe("json");
      const preview = await previewer.generate(
        {
          filename: "response.json",
          mimeType: "application/json",
          sizeBytes: buffer.length,
        },
        buffer,
        {},
        testContext
      );

      if (preview.type === "json") {
        expect(preview.isArray).toBe(false);
        expect(preview.topKeys).toEqual(["status", "users"]);
        expect(preview.formatted).toContain('  "status": "ok"');
      }
    });

    test("handles generic fallback for binary/archives", async () => {
      const binaryBuffer = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00]);
      const previewer = defaultPreviewRegistry.findPreviewer({
        filename: "archive.bin",
        mimeType: "application/octet-stream",
      });

      expect(previewer.type).toBe("generic");
      const preview = await previewer.generate(
        {
          filename: "archive.bin",
          mimeType: "application/octet-stream",
          sizeBytes: binaryBuffer.length,
        },
        binaryBuffer,
        {},
        testContext
      );

      expect(preview.type).toBe("generic");
      expect(preview.status).toBe("unsupported");
      expect(preview.downloadUrl).toContain("archive.bin");
    });
  });

  describe("PreviewService Cache & Security", () => {
    test("caches generated preview and invalidates upon request", async () => {
      const service = new PreviewService();
      const textBuffer = Buffer.from("Hello Atlas Artifact Preview", "utf8");

      const preview1 = await service.generate(
        {
          filename: "note.txt",
          mimeType: "text/plain",
          path: "note.txt",
          revision: 1,
          sizeBytes: textBuffer.length,
        },
        textBuffer,
        {},
        testContext
      );

      expect(preview1.cached).toBeUndefined();

      // Second fetch should hit cache
      const preview2 = await service.generate(
        {
          filename: "note.txt",
          mimeType: "text/plain",
          path: "note.txt",
          revision: 1,
          sizeBytes: textBuffer.length,
        },
        textBuffer,
        {},
        testContext
      );

      expect(preview2.cached).toBe(true);

      // Invalidate
      service.invalidate(testContext.orgId, testContext.profileId, "note.txt");

      const preview3 = await service.generate(
        {
          filename: "note.txt",
          mimeType: "text/plain",
          path: "note.txt",
          revision: 1,
          sizeBytes: textBuffer.length,
        },
        textBuffer,
        {},
        testContext
      );

      expect(preview3.cached).toBeUndefined();
    });

    test("enforces maximum file size limit", async () => {
      const service = new PreviewService();
      const largeBuffer = Buffer.alloc(MAX_PREVIEW_FILE_SIZE_BYTES + 100);

      const preview = await service.generate(
        {
          filename: "huge.dat",
          mimeType: "application/octet-stream",
          path: "huge.dat",
          sizeBytes: largeBuffer.length,
        },
        largeBuffer,
        {},
        testContext
      );

      expect(preview.status).toBe("failed");
      expect(preview.error).toContain("exceeds maximum preview limit");
    });

    test("generates canonical PreviewManifest and deduplicates in-flight jobs", async () => {
      const service = new PreviewService();
      const textBuffer = Buffer.from(
        "# Project Spec\n\nAtlas preview test.",
        "utf8"
      );

      const manifestPromise1 = service.generateManifest(
        {
          artifactId: "art_spec1",
          filename: "spec.md",
          mimeType: "text/markdown",
          revision: 1,
          sizeBytes: textBuffer.length,
        },
        textBuffer,
        {},
        testContext
      );

      const manifestPromise2 = service.generateManifest(
        {
          artifactId: "art_spec1",
          filename: "spec.md",
          mimeType: "text/markdown",
          revision: 1,
          sizeBytes: textBuffer.length,
        },
        textBuffer,
        {},
        testContext
      );

      const [m1, m2] = await Promise.all([manifestPromise1, manifestPromise2]);
      expect(m1.artifactId).toBe("art_spec1");
      expect(m1.type).toBe("markdown");
      expect(m1.assets.length).toBeGreaterThanOrEqual(1);
      expect(m1.contentHash).toBeDefined();
      expect(m2.contentHash).toBe(m1.contentHash);
    });

    test("handles spreadsheet range slicing (e.g. A1:B2)", async () => {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Data");
      ws.addRow(["A", "B", "C", "D"]);
      ws.addRow([10, 20, 30, 40]);
      ws.addRow([100, 200, 300, 400]);
      ws.addRow([1000, 2000, 3000, 4000]);

      const buffer = (await wb.xlsx.writeBuffer()) as Buffer;
      const previewer = defaultPreviewRegistry.findPreviewer({
        filename: "test.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const slicedPreview = await previewer.generate(
        {
          filename: "test.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: buffer.length,
        },
        buffer,
        { range: "A1:B2" },
        testContext
      );

      if (slicedPreview.type === "spreadsheet") {
        expect(slicedPreview.activeSheet.data.length).toBe(2);
        expect(slicedPreview.activeSheet.data[0]).toEqual(["A", "B"]);
        expect(slicedPreview.activeSheet.data[1]).toEqual([10, 20]);
      }
    });

    test("rejects legacy binary .xls with clean unsupported state", async () => {
      // Legacy XLS header (CFB 0xD0CF11E0)
      const legacyXlsBuffer = Buffer.from([
        0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
      ]);
      const previewer = defaultPreviewRegistry.findPreviewer(
        {
          filename: "old_data.xls",
          mimeType: "application/vnd.ms-excel",
        },
        legacyXlsBuffer
      );

      const preview = await previewer.generate(
        {
          filename: "old_data.xls",
          mimeType: "application/vnd.ms-excel",
          sizeBytes: legacyXlsBuffer.length,
        },
        legacyXlsBuffer,
        {},
        testContext
      );

      expect(preview.status).toBe("unsupported");
      expect(preview.error).toContain("Legacy Excel");
    });

    test("protects against MIME spoofing and rejects disguised executables", async () => {
      // Executable bytes claiming to be PDF
      const fakePdfBuffer = Buffer.from(
        "MZ\x90\x00\x03\x00\x00\x00FakePEHeaderData"
      );
      const previewer = defaultPreviewRegistry.findPreviewer(
        {
          filename: "malicious.pdf",
          mimeType: "application/pdf",
        },
        fakePdfBuffer
      );

      // Must be routed to generic fallback instead of PdfPreviewer
      expect(previewer.type).toBe("generic");
    });

    test("deeply sanitizes SVG content removing foreignObject, script, and on* handlers", async () => {
      const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert('xss')</script>
        <foreignObject width="100" height="50">
          <body xmlns="http://www.w3.org/1999/xhtml">
            <iframe src="javascript:alert(1)"></iframe>
          </body>
        </foreignObject>
        <circle cx="50" cy="50" r="40" fill="red" onclick="evil()" />
      </svg>`;

      const imagePreviewer = defaultPreviewRegistry.findPreviewer({
        filename: "test.svg",
        mimeType: "image/svg+xml",
      });

      expect(imagePreviewer.type).toBe("image");
      const { sanitizeSvg } = await import("./previewers/image-previewer");
      const sanitized = sanitizeSvg(maliciousSvg);

      expect(sanitized).not.toContain("<script>");
      expect(sanitized).not.toContain("<foreignObject");
      expect(sanitized).not.toContain("onload=");
      expect(sanitized).not.toContain("onclick=");
      expect(sanitized).toContain("<circle");
    });

    test("deeply sanitizes HTML content and injects strict CSP", async () => {
      const rawHtml = `<!DOCTYPE html><html><head><title>Secure Page</title></head><body><script>alert('hack')</script><h1 onclick="run()">Hello World</h1></body></html>`;
      const { sanitizeAndSandboxedHtml } = await import(
        "./previewers/html-previewer"
      );
      const safe = sanitizeAndSandboxedHtml(rawHtml);

      expect(safe).not.toContain("<script>");
      expect(safe).not.toContain("onclick=");
      expect(safe).toContain("Content-Security-Policy");
      expect(safe).toContain("default-src 'none'");
      expect(safe).toContain("Hello World");
    });
  });
});
