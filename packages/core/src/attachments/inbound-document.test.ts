import { describe, expect, test } from "bun:test";
import {
  CHANNEL_DOCUMENT_SAVE_FAILED_REPLY,
  prepareChannelDocument,
} from "./inbound-document";

const document = {
  bytes: Buffer.from("a long source document"),
  caption: "Analyze the whole source",
  channel: "Test",
  filename: "notes.txt",
  inlineMaxBytes: 5,
  mediaType: "text/plain",
};

describe("channel document preparation", () => {
  test("fails closed when original storage is unavailable, without extracting", async () => {
    let extractions = 0;
    const result = await prepareChannelDocument({
      ...document,
      extractDocumentText: async () => {
        extractions++;
        return { text: "preview", truncated: false };
      },
    });
    expect(result.kind).toBe("reject");
    expect(extractions).toBe(0);
  });

  for (const [filename, mediaType] of [
    ["sales.xlsx", "application/octet-stream"],
    ["sales.xls", "application/octet-stream"],
    ["sales.xlsm", "application/octet-stream"],
    ["sales.xlsb", "application/octet-stream"],
    ["sales.csv", "text/csv"],
    ["report.pdf", "application/pdf"],
    ["report.docx", "application/octet-stream"],
    ["notes.txt", "text/plain"],
    ["notes.md", "text/markdown"],
  ]) {
    test(`saves original ${filename} bytes even below the inline threshold`, async () => {
      const bytes = Buffer.from("original source bytes");
      const saves: Buffer[] = [];
      const result = await prepareChannelDocument({
        ...document,
        bytes,
        filename: filename!,
        mediaType: mediaType!,
        saveInboundDocument: async (input) => {
          saves.push(input.bytes);
          return {
            relativePath: `artifacts/${filename}`,
            sizeBytes: input.bytes.length,
          };
        },
      });
      expect(saves).toEqual([bytes]);
      expect(result.kind).toBe("input");
      if (result.kind === "input") {
        expect(result.input.documents).toBeUndefined();
        expect(result.input.message).toContain(`artifacts/${filename}`);
        expect(result.input.message).not.toContain(bytes.toString());
        expect(result.input.message).not.toContain("[File:");
      }
    });
  }

  test("never begins a source write after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let saves = 0;
    await expect(
      prepareChannelDocument({
        ...document,
        saveInboundDocument: async () => {
          saves++;
          return {
            relativePath: "artifacts/notes.txt",
            sizeBytes: document.bytes.length,
          };
        },
        signal: controller.signal,
      })
    ).rejects.toThrow();
    expect(saves).toBe(0);
  });

  test("rejects unsafe source references and failed writes without extraction fallback", async () => {
    for (const relativePath of [
      "../notes.txt",
      "artifacts/../notes.txt",
      "artifacts\\notes.txt",
      "artifacts/notes\n.txt",
    ]) {
      let extractions = 0;
      const result = await prepareChannelDocument({
        ...document,
        extractDocumentText: async () => {
          extractions++;
          return { text: "preview", truncated: false };
        },
        saveInboundDocument: async () => ({
          relativePath,
          sizeBytes: document.bytes.length,
        }),
      });
      expect(result).toEqual({
        kind: "reject",
        message: CHANNEL_DOCUMENT_SAVE_FAILED_REPLY,
      });
      expect(extractions).toBe(0);
    }
  });
});
