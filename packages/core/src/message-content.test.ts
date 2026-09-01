import { describe, expect, test } from "bun:test";
import { AtlasApiError } from "./api-error";
import {
  countUserImages,
  estimateUserContentTokens,
  getUserMessageText,
  isSpreadsheetDocumentMediaType,
  isSupportedDocumentMediaType,
  isSupportedImageMediaType,
  normalizeImageMediaType,
  normalizeUserContent,
  parseDataUrl,
  stripImagesForCompaction,
  validateCombinedAttachmentCount,
  validateDocumentAttachments,
  validateImageAttachments,
} from "./message-content";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("browser-compatible attachment validation", () => {
  test("loads and validates an image without the Node Buffer global", async () => {
    const moduleUrl = new URL("./message-content.ts", import.meta.url).href;
    const script = [
      "globalThis.Buffer = undefined;",
      `const module = await import(${JSON.stringify(moduleUrl)});`,
      `module.validateImageAttachments([{ data: ${JSON.stringify(tinyPngBase64)}, mediaType: "image/png" }]);`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});

describe("shared attachment allowlist", () => {
  test("accepts web document types including xlsx", () => {
    expect(
      isSupportedDocumentMediaType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "sheet.xlsx"
      )
    ).toBe(true);
    expect(isSupportedDocumentMediaType("application/pdf", "report.pdf")).toBe(
      true
    );
    expect(isSupportedDocumentMediaType("application/zip", "archive.zip")).toBe(
      false
    );
  });

  test("detects excel workbooks as spreadsheet documents", () => {
    expect(
      isSpreadsheetDocumentMediaType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "sheet.xlsx"
      )
    ).toBe(true);
    expect(
      isSpreadsheetDocumentMediaType("application/octet-stream", "budget.xls")
    ).toBe(true);
    expect(
      isSpreadsheetDocumentMediaType("application/pdf", "report.pdf")
    ).toBe(false);
  });

  test("accepts jpeg png gif webp images", () => {
    expect(isSupportedImageMediaType("image/jpeg")).toBe(true);
    expect(isSupportedImageMediaType("image/jpg")).toBe(true);
    expect(isSupportedImageMediaType(" IMAGE/PNG; charset=binary ")).toBe(true);
    expect(isSupportedImageMediaType("image/heic")).toBe(false);
    expect(normalizeImageMediaType(" IMAGE/JPG; charset=binary ")).toBe(
      "image/jpeg"
    );
  });
});

describe("normalizeUserContent", () => {
  test("returns parts when images present", () => {
    const result = normalizeUserContent("see this", [
      { data: tinyPngBase64, mediaType: "image/png" },
    ]);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { text: "see this", type: "text" },
      { data: tinyPngBase64, mediaType: "image/png", type: "image" },
    ]);
  });

  test("allows image-only message", () => {
    const result = normalizeUserContent("", [
      { data: tinyPngBase64, mediaType: "image/png" },
    ]);

    expect(result).toEqual([
      { data: tinyPngBase64, mediaType: "image/png", type: "image" },
    ]);
  });

  test("canonicalizes image media types before storing content", () => {
    const jpegBase64 =
      "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z";
    const result = normalizeUserContent("", [
      {
        data: jpegBase64,
        mediaType: " IMAGE/JPG; charset=binary ",
      },
    ]);

    expect(result).toEqual([
      { data: jpegBase64, mediaType: "image/jpeg", type: "image" },
    ]);
  });

  test("returns parts when documents present", () => {
    const result = normalizeUserContent("summarize", undefined, [
      {
        data: "SGVsbG8=",
        filename: "notes.txt",
        mediaType: "text/plain",
      },
    ]);

    expect(result).toEqual([
      { text: "summarize", type: "text" },
      {
        data: "SGVsbG8=",
        filename: "notes.txt",
        mediaType: "text/plain",
        type: "document",
      },
    ]);
  });

  test("canonicalizes document media types from the filename", () => {
    const result = normalizeUserContent("summarize", undefined, [
      {
        data: "SGVsbG8=",
        filename: "REPORT.PDF",
        mediaType: "application/octet-stream",
      },
    ]);

    expect(result).toEqual([
      { text: "summarize", type: "text" },
      {
        data: "SGVsbG8=",
        filename: "REPORT.PDF",
        mediaType: "application/pdf",
        type: "document",
      },
    ]);
  });

  test("strips document MIME parameters when no extension is available", () => {
    const result = normalizeUserContent("read", undefined, [
      {
        data: "SGVsbG8=",
        filename: "README",
        mediaType: "text/plain; charset=utf-8",
      },
    ]);

    expect(result).toEqual([
      { text: "read", type: "text" },
      {
        data: "SGVsbG8=",
        filename: "README",
        mediaType: "text/plain",
        type: "document",
      },
    ]);
  });

  test("allows document-only message", () => {
    const result = normalizeUserContent("", undefined, [
      {
        data: "SGVsbG8=",
        filename: "notes.txt",
        mediaType: "text/plain",
      },
    ]);

    expect(result).toEqual([
      {
        data: "SGVsbG8=",
        filename: "notes.txt",
        mediaType: "text/plain",
        type: "document",
      },
    ]);
  });
});

describe("validateImageAttachments", () => {
  test("accepts structurally valid png, jpeg, gif, and webp images", () => {
    const images = [
      { data: tinyPngBase64, mediaType: "image/png" },
      {
        data: "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z",
        mediaType: "image/jpeg",
      },
      {
        data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
        mediaType: "image/gif",
      },
      {
        data: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
        mediaType: "image/webp",
      },
    ];

    expect(() => validateImageAttachments(images)).not.toThrow();
  });

  test("rejects unsupported media type", () => {
    expect(() =>
      validateImageAttachments([
        { data: tinyPngBase64, mediaType: "image/bmp" },
      ])
    ).toThrow(AtlasApiError);
  });

  test("rejects oversized image", () => {
    const huge = "A".repeat((6 * 1024 * 1024 * 4) / 3);
    expect(() =>
      validateImageAttachments([{ data: huge, mediaType: "image/png" }])
    ).toThrow(AtlasApiError);
  });

  test("rejects malformed base64 before decoding", () => {
    expect(() =>
      validateImageAttachments([
        { data: "not-base64!", mediaType: "image/png" },
      ])
    ).toThrow("valid base64");
  });

  test("rejects image bytes that do not match the declared media type", () => {
    expect(() =>
      validateImageAttachments([
        {
          data: Buffer.from("not a png").toString("base64"),
          mediaType: "image/png",
        },
      ])
    ).toThrow("structurally valid");
  });

  test("rejects a signature-only image", () => {
    expect(() =>
      validateImageAttachments([
        {
          data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
          mediaType: "image/jpeg",
        },
      ])
    ).toThrow("structurally valid");
  });

  test("rejects compressed images with unsafe pixel dimensions", () => {
    const oversizedDimensions = Buffer.from(tinyPngBase64, "base64");
    oversizedDimensions.writeUInt32BE(10_000, 16);
    oversizedDimensions.writeUInt32BE(10_000, 20);

    expect(() =>
      validateImageAttachments([
        {
          data: oversizedDimensions.toString("base64"),
          mediaType: "image/png",
        },
      ])
    ).toThrow("dimensions are too large");
  });
});

describe("validateDocumentAttachments", () => {
  test("rejects unsupported media type", () => {
    expect(() =>
      validateDocumentAttachments([
        {
          data: "YWJj",
          filename: "bad.bin",
          mediaType: "application/octet-stream",
        },
      ])
    ).toThrow(AtlasApiError);
  });

  test("rejects an empty data-url payload", () => {
    expect(() =>
      validateDocumentAttachments([
        {
          data: "data:text/plain;base64,",
          filename: "empty.txt",
          mediaType: "text/plain",
        },
      ])
    ).toThrow("must not be empty");
  });

  test("rejects base64 with non-canonical padding bits", () => {
    expect(() =>
      validateDocumentAttachments([
        {
          data: "Zh==",
          filename: "notes.txt",
          mediaType: "text/plain",
        },
      ])
    ).toThrow("canonical base64");
  });

  test("accepts markdown attachments", () => {
    expect(() =>
      validateDocumentAttachments([
        {
          data: "Iw==",
          filename: "notes.md",
          mediaType: "text/markdown",
        },
      ])
    ).not.toThrow();
  });

  test("accepts excel attachments under the size limit", () => {
    expect(() =>
      validateDocumentAttachments([
        {
          data: "YWJj",
          filename: "budget.xlsx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ])
    ).not.toThrow();
  });

  test("normalizes excel extension when media type is generic", () => {
    expect(() =>
      validateDocumentAttachments([
        {
          data: "YWJj",
          filename: "budget.xlsx",
          mediaType: "application/octet-stream",
        },
      ])
    ).not.toThrow();
  });

  test("rejects oversized document", () => {
    const huge = "A".repeat((6 * 1024 * 1024 * 4) / 3);
    expect(() =>
      validateDocumentAttachments([
        { data: huge, filename: "big.pdf", mediaType: "application/pdf" },
      ])
    ).toThrow(AtlasApiError);
  });

  test("rejects oversized excel the same way as other documents", () => {
    const huge = "A".repeat((6 * 1024 * 1024 * 4) / 3);
    expect(() =>
      validateDocumentAttachments([
        {
          data: huge,
          filename: "big.xlsx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ])
    ).toThrow(AtlasApiError);
  });
});

describe("validateCombinedAttachmentCount", () => {
  test("rejects more than five attachments total", () => {
    expect(() => validateCombinedAttachmentCount(3, 3)).toThrow(AtlasApiError);
  });
});

describe("getUserMessageText", () => {
  test("extracts text from parts", () => {
    expect(
      getUserMessageText([
        { text: "line one", type: "text" },
        { data: tinyPngBase64, mediaType: "image/png", type: "image" },
        { text: "line two", type: "text" },
      ])
    ).toBe("line one\nline two");
  });
});

describe("estimateUserContentTokens", () => {
  test("adds fixed tokens per image", () => {
    const tokens = estimateUserContentTokens([
      { text: "hi", type: "text" },
      { data: tinyPngBase64, mediaType: "image/png", type: "image" },
    ]);

    expect(tokens).toBeGreaterThan(1400);
  });
});

describe("stripImagesForCompaction", () => {
  test("replaces image parts with placeholder text", () => {
    const result = stripImagesForCompaction([
      {
        content: [
          { text: "diagram", type: "text" },
          { data: tinyPngBase64, mediaType: "image/png", type: "image" },
        ],
        role: "user",
      },
    ]);

    expect(result[0]).toEqual({
      content: "diagram\n[1 image omitted from summary]",
      role: "user",
    });
  });
});

describe("parseDataUrl", () => {
  test("parses valid data url", () => {
    expect(parseDataUrl(`data:image/png;base64,${tinyPngBase64}`)).toEqual({
      data: tinyPngBase64,
      mediaType: "image/png",
    });
  });

  test("canonicalizes the parsed image media type", () => {
    expect(
      parseDataUrl(`data:IMAGE/JPG;base64,${tinyPngBase64}`)?.mediaType
    ).toBe("image/jpeg");
  });

  test("returns null for invalid url", () => {
    expect(parseDataUrl("not-a-data-url")).toBeNull();
  });
});

describe("countUserImages", () => {
  test("counts image parts", () => {
    expect(
      countUserImages([
        { text: "x", type: "text" },
        { data: tinyPngBase64, mediaType: "image/png", type: "image" },
      ])
    ).toBe(1);
  });
});
