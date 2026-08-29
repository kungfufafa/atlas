import { describe, expect, it } from "bun:test";
import {
  displayFileKind,
  fileBasename,
  fileFolder,
  isEditableFile,
  isImagePreviewable,
  isTextPreviewable,
} from "./file-display";

describe("file display", () => {
  it("uses the basename and folder from a nested path", () => {
    expect(fileBasename("snake-game/index.html")).toBe("index.html");
    expect(fileFolder("snake-game/index.html")).toBe("snake-game");
    expect(fileFolder("notes.md")).toBeNull();
  });

  it("labels common artifacts without dumping MIME types", () => {
    expect(
      displayFileKind(
        "hasil_penjualan_demo.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
    ).toBe("Spreadsheet");
    expect(displayFileKind("verify-preview.pdf", "application/pdf")).toBe(
      "PDF"
    );
    expect(displayFileKind("verify-chat.md", "text/markdown")).toBe("Markdown");
    expect(displayFileKind("verify-icon.svg", "image/svg+xml")).toBe("SVG");
    expect(displayFileKind("snake-game/index.html", "text/html")).toBe("HTML");
  });

  it("chooses preview vs share based on the file kind", () => {
    expect(isImagePreviewable("photo.png", "image/png")).toBe(true);
    expect(isImagePreviewable("verify-icon.svg", "image/svg+xml")).toBe(false);
    expect(isTextPreviewable("verify-chat.md", "text/markdown")).toBe(true);
    expect(isTextPreviewable("verify-app.jsx", "text/plain")).toBe(true);
    expect(isTextPreviewable("hasil_penjualan_demo.xlsx")).toBe(false);
    expect(isEditableFile("notes.md")).toBe(true);
    expect(isEditableFile("book.xlsx")).toBe(false);
  });
});
