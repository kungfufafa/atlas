import PptxGenJS from "pptxgenjs";
import { z } from "zod";

export const presentationSlideSchema = z.object({
  backgroundColor: z
    .string()
    .optional()
    .describe("Hex color code e.g. '#1E293B' or 'F8FAFC'"),
  bulletPoints: z
    .array(z.string())
    .optional()
    .describe("List of bullet points for the slide"),
  layout: z
    .enum(["title", "content", "two_column", "quote", "blank"])
    .optional()
    .default("content")
    .describe("Slide layout type"),
  notes: z.string().optional().describe("Speaker notes for this slide"),
  subtitle: z
    .string()
    .optional()
    .describe("Optional subtitle or category header"),
  table: z
    .object({
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    })
    .optional()
    .describe("Structured table data to render on slide"),
  textBlocks: z.array(z.string()).optional().describe("Paragraph text blocks"),
  title: z.string().optional().describe("Slide title"),
});

export const presentationDefinitionSchema = z.object({
  author: z.string().optional().describe("Author or creator name"),
  company: z.string().optional().describe("Organization name"),
  slides: z
    .array(presentationSlideSchema)
    .min(1, "Presentation must contain at least 1 slide"),
  themeColor: z
    .string()
    .optional()
    .default("3B82F6")
    .describe("Hex accent color (without #)"),
  title: z.string().min(1, "Presentation title is required"),
});

export type PresentationSlide = z.infer<typeof presentationSlideSchema>;
export type PresentationDefinition = z.infer<
  typeof presentationDefinitionSchema
>;

export async function createPptxBuffer(
  definition: PresentationDefinition
): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.title = definition.title;
  if (definition.author) {
    pptx.author = definition.author;
  }
  if (definition.company) {
    pptx.company = definition.company;
  }

  const accentColor = (definition.themeColor || "3B82F6").replace(/^#/, "");

  for (const [idx, slideDef] of definition.slides.entries()) {
    const slide = pptx.addSlide();

    // Background color
    if (slideDef.backgroundColor) {
      slide.background = { color: slideDef.backgroundColor.replace(/^#/, "") };
    } else if (idx === 0) {
      slide.background = { color: "0F172A" }; // dark cover
    } else {
      slide.background = { color: "FFFFFF" };
    }

    const isCover =
      idx === 0 && (slideDef.layout === "title" || !slideDef.layout);
    const titleColor = isCover ? "F8FAFC" : "0F172A";
    const bodyColor = isCover ? "94A3B8" : "334155";

    // Slide Title
    if (slideDef.title) {
      slide.addText(slideDef.title, {
        align: isCover ? "center" : "left",
        bold: true,
        color: titleColor,
        fontSize: isCover ? 36 : 24,
        h: isCover ? 1.2 : 0.8,
        w: isCover ? 11.3 : 11.5,
        x: isCover ? 1.0 : 0.8,
        y: isCover ? 2.2 : 0.6,
      });
    }

    // Subtitle
    if (slideDef.subtitle) {
      slide.addText(slideDef.subtitle, {
        align: isCover ? "center" : "left",
        bold: true,
        color: accentColor,
        fontSize: isCover ? 20 : 14,
        h: 0.6,
        w: isCover ? 11.3 : 11.5,
        x: isCover ? 1.0 : 0.8,
        y: isCover ? 3.5 : 1.4,
      });
    }

    let startY = slideDef.subtitle ? 2.1 : 1.6;

    // Bullet points
    if (slideDef.bulletPoints && slideDef.bulletPoints.length > 0) {
      const items = slideDef.bulletPoints.map((text) => ({
        options: {
          bullet: true,
          color: bodyColor,
          fontSize: 16,
          indentLevel: 0,
        },
        text,
      }));

      slide.addText(items, {
        h: 3.5,
        margin: 0.1,
        w: 11.5,
        x: 0.8,
        y: startY,
      });
      startY += 3.0;
    }

    // Paragraph text blocks
    if (slideDef.textBlocks && slideDef.textBlocks.length > 0) {
      for (const block of slideDef.textBlocks) {
        slide.addText(block, {
          color: bodyColor,
          fontSize: 15,
          h: 1.0,
          w: 11.5,
          x: 0.8,
          y: startY,
        });
        startY += 1.1;
      }
    }

    // Table
    if (slideDef.table && slideDef.table.headers.length > 0) {
      const tableRows: PptxGenJS.TableRow[] = [];

      // Header row
      tableRows.push(
        slideDef.table.headers.map((h) => ({
          options: {
            bold: true,
            color: "FFFFFF",
            fill: { color: accentColor },
            fontSize: 14,
          },
          text: h,
        }))
      );

      // Data rows
      for (const row of slideDef.table.rows) {
        tableRows.push(
          row.map((cell) => ({
            options: {
              color: bodyColor,
              fill: { color: "F8FAFC" },
              fontSize: 13,
            },
            text: cell,
          }))
        );
      }

      slide.addTable(tableRows, {
        w: 11.5,
        x: 0.8,
        y: startY,
      });
    }

    // Speaker notes
    if (slideDef.notes) {
      slide.addNotes(slideDef.notes);
    }
  }

  const raw = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
}

export async function inspectPptxBuffer(
  buffer: Buffer
): Promise<{ slideCount: number; title?: string }> {
  const { unzipSync } = await import("fflate");
  const unzipped = unzipSync(new Uint8Array(buffer));

  // Count slide XML files: ppt/slides/slide1.xml, ppt/slides/slide2.xml, ...
  const slideKeys = Object.keys(unzipped).filter(
    (k) => k.startsWith("ppt/slides/slide") && k.endsWith(".xml")
  );

  return {
    slideCount: slideKeys.length,
  };
}
