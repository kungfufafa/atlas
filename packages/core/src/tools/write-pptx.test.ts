import { describe, expect, test } from "bun:test";
import { createPptxBuffer, inspectPptxBuffer } from "../presentation-engine";
import { writePptxTool } from "./write-pptx";

describe("Presentation Engine", () => {
  test("creates valid PPTX buffer with specified slides and inspects slide count", async () => {
    const buffer = await createPptxBuffer({
      author: "Atlas Principal Engineer",
      company: "Atlas AI",
      slides: [
        {
          layout: "title",
          subtitle: "Autonomous Agent Capability Platform",
          title: "Atlas Architecture Overview",
        },
        {
          bulletPoints: [
            "Research-grade web search & fetch",
            "Interactive browser session runtime",
            "Multi-scoped persistent memory",
          ],
          title: "Tool Platform",
        },
        {
          notes: "Explain synthesis and inline citations",
          textBlocks: [
            "Orchestrates parallel search, evidence extraction, and conflict resolution.",
          ],
          title: "Research Capability",
        },
      ],
      themeColor: "3B82F6",
      title: "Atlas Overview",
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);

    const inspection = await inspectPptxBuffer(buffer);
    expect(inspection.slideCount).toBe(3);
  });
});

describe("write_pptx tool validation", () => {
  test("rejects path not ending in .pptx", async () => {
    await expect(
      writePptxTool.run(
        {
          path: "presentation.pdf",
          slides: [{ title: "Slide 1" }],
          title: "Test",
        },
        {}
      )
    ).rejects.toThrow(/\.pptx/);
  });
});
