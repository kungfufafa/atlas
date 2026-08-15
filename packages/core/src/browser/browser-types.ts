import { z } from "zod";
import type { ToolArtifact } from "../tools/execution-contract";

export const BROWSER_TOOL_NAME = "browser";

export const browserActionSchema = z.enum([
  "open",
  "navigate",
  "click",
  "type",
  "select",
  "scroll",
  "find",
  "screenshot",
  "back",
  "forward",
  "reload",
  "download",
  "close",
]);

export type BrowserAction = z.infer<typeof browserActionSchema>;

export const browserInputSchema = z
  .object({
    action: browserActionSchema.describe(
      "The browser action: 'open' | 'navigate' (open URL), 'click' (click element), 'type' (type into element), 'select' (choose option), 'scroll' (scroll page), 'find' (find text), 'screenshot' (capture image), 'back', 'forward', 'reload', 'download' (download current link or wait for download), 'close'."
    ),
    clear: z
      .boolean()
      .optional()
      .describe(
        "When true with 'type', clears input before typing. Defaults to true."
      ),
    direction: z
      .enum(["up", "down", "top", "bottom"])
      .optional()
      .describe("Scroll direction for 'scroll' action. Defaults to 'down'."),
    element: z
      .string()
      .optional()
      .describe(
        "Element reference from page snapshot (e.g. 'e1', 'e2') or CSS selector."
      ),
    fullPage: z
      .boolean()
      .optional()
      .describe(
        "When true with 'screenshot', captures the entire scrollable page."
      ),
    query: z
      .string()
      .optional()
      .describe("Search query text for 'find' action."),
    selector: z
      .string()
      .optional()
      .describe("Direct CSS selector if not using element ref."),
    text: z.string().optional().describe("Text to type for 'type' action."),
    url: z
      .string()
      .optional()
      .describe("Target URL for 'open' or 'navigate' action."),
    value: z
      .string()
      .optional()
      .describe("Value to select for 'select' action."),
  })
  .strict();

export type BrowserInput = z.infer<typeof browserInputSchema>;

export interface InteractiveElement {
  name: string;
  ref: string;
  role: string;
  selector?: string;
  value?: string;
}

export interface BrowserPageSnapshot {
  downloadArtifact?: ToolArtifact;
  interactiveElements: InteractiveElement[];
  links: Array<{ text: string; url: string }>;
  screenshotArtifact?: ToolArtifact;
  text: string;
  title: string;
  truncated: boolean;
  url: string;
}

export interface BrowserToolOutput {
  action: BrowserAction;
  artifacts?: ToolArtifact[];
  message?: string;
  snapshot?: BrowserPageSnapshot;
  status: "success" | "error";
}
