import { z } from "zod";
import type { ToolDefinition } from "../contract";
import { presentationSlideSchema } from "../presentation-engine";
import { runWritePptx } from "./builtin";
import {
  jsonSchemaFromZod,
  requiredTrimmedString,
  trimmedOptionalString,
} from "./schema";

export const writePptxInputSchema = z
  .object({
    author: z.string().optional().describe("Author or speaker name"),
    company: z.string().optional().describe("Company or organization name"),
    cwd: trimmedOptionalString,
    path: requiredTrimmedString("path").describe(
      "Path ending in .pptx relative to profile workspace (e.g. 'atlas_overview.pptx')"
    ),
    slides: z
      .array(presentationSlideSchema)
      .min(1, "Presentation must contain at least 1 slide")
      .describe(
        "Array of slides with titles, bullet points, text blocks, or tables"
      ),
    themeColor: z
      .string()
      .optional()
      .describe("Accent theme color code (e.g. '3B82F6', '10B981')"),
    title: requiredTrimmedString("title").describe(
      "Presentation overall title"
    ),
  })
  .strict();

export type WritePptxInput = z.infer<typeof writePptxInputSchema>;

export interface WritePptxOutput {
  bytesWritten: number;
  path: string;
  slideCount: number;
}

export const writePptxTool: ToolDefinition<WritePptxInput, WritePptxOutput> = {
  description:
    "Create a real Microsoft PowerPoint (.pptx) presentation with structured slides, titles, bullet points, tables, and themes. Use this whenever the user asks for a presentation or slide deck.",
  name: "write_pptx",
  parameters: jsonSchemaFromZod(writePptxInputSchema),
  run(input, context) {
    return runWritePptx(input, context);
  },
};
