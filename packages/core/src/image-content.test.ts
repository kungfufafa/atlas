import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./contract";
import {
  extractImageParts,
  formatImageDescriptionText,
  isImageDescriptionText,
  parseImageDescriptionText,
  replaceImagePartsWithDescriptions,
  resolveMessagesForNonVisionProvider,
  resolveUserContentForNonVisionProvider,
} from "./image-content";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("extractImageParts", () => {
  test("returns empty array for plain text", () => {
    expect(extractImageParts("hello")).toEqual([]);
  });

  test("extracts image parts from content array", () => {
    const parts = extractImageParts([
      { text: "What is this?", type: "text" },
      { data: tinyPngBase64, mediaType: "image/png", type: "image" },
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]?.mediaType).toBe("image/png");
  });
});

describe("replaceImagePartsWithDescriptions", () => {
  test("annotates image parts with descriptions", () => {
    const result = replaceImagePartsWithDescriptions(
      [
        { text: "What is this?", type: "text" },
        { data: tinyPngBase64, mediaType: "image/png", type: "image" },
      ],
      ["A red square on white background."]
    );

    expect(result).toEqual([
      { text: "What is this?", type: "text" },
      {
        data: tinyPngBase64,
        description: "A red square on white background.",
        mediaType: "image/png",
        type: "image",
      },
    ]);
  });

  test("returns plain string when only image descriptions remain for string content", () => {
    const result = replaceImagePartsWithDescriptions(
      [{ data: tinyPngBase64, mediaType: "image/png", type: "image" }],
      ["A chart with three bars."]
    );

    expect(result).toEqual([
      {
        data: tinyPngBase64,
        description: "A chart with three bars.",
        mediaType: "image/png",
        type: "image",
      },
    ]);
  });

  test("annotates persisted image refs without restoring inline bytes", () => {
    const result = replaceImagePartsWithDescriptions(
      [
        {
          attachmentId: "attachment-1",
          mediaType: "image/png",
          size: 123,
          type: "image_ref",
        },
      ],
      ["A persisted chart."]
    );

    expect(result).toEqual([
      {
        attachmentId: "attachment-1",
        description: "A persisted chart.",
        mediaType: "image/png",
        size: 123,
        type: "image_ref",
      },
    ]);
  });
});

describe("image description text helpers", () => {
  test("formats and parses image description text", () => {
    const text = formatImageDescriptionText("A diagram with arrows.");
    expect(isImageDescriptionText(text)).toBe(true);
    expect(parseImageDescriptionText(text)).toBe("A diagram with arrows.");
  });
});

describe("resolveUserContentForNonVisionProvider", () => {
  test("converts described image parts to text", () => {
    const result = resolveUserContentForNonVisionProvider([
      { text: "What is this?", type: "text" },
      {
        data: tinyPngBase64,
        description: "A red square.",
        mediaType: "image/png",
        type: "image",
      },
    ]);

    expect(result).toEqual([
      { text: "What is this?", type: "text" },
      { text: "[Image]\nA red square.", type: "text" },
    ]);
  });

  test("passes through image parts without descriptions", () => {
    const imagePart = {
      data: tinyPngBase64,
      mediaType: "image/png",
      type: "image",
    } as const;
    expect(resolveUserContentForNonVisionProvider([imagePart])).toEqual([
      imagePart,
    ]);
  });

  test("converts described image refs to text for non-vision models", () => {
    expect(
      resolveUserContentForNonVisionProvider([
        {
          attachmentId: "attachment-1",
          description: "A chart with three bars.",
          mediaType: "image/png",
          size: 123,
          type: "image_ref",
        },
      ])
    ).toBe("[Image]\nA chart with three bars.");
  });
});

describe("resolveMessagesForNonVisionProvider", () => {
  test("maps only user messages", () => {
    const messages: ChatMessage[] = [
      {
        content: [
          {
            data: tinyPngBase64,
            description: "A chart.",
            mediaType: "image/png",
            type: "image",
          },
        ],
        role: "user",
      },
      { content: "Looks like a chart.", role: "assistant" },
    ];

    expect(resolveMessagesForNonVisionProvider(messages)).toEqual([
      { content: "[Image]\nA chart.", role: "user" },
      { content: "Looks like a chart.", role: "assistant" },
    ]);
  });
});
