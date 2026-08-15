import {
  BROWSER_TOOL_NAME,
  type BrowserInput,
  type BrowserToolOutput,
  browserInputSchema,
} from "../browser/browser-types";
import type { ToolContext, ToolDefinition } from "../contract";
import { jsonSchemaFromZod } from "./schema";

export type BrowserExecutionHandler = (
  input: BrowserInput,
  context: ToolContext
) => Promise<BrowserToolOutput>;

let registeredBrowserHandler: BrowserExecutionHandler | null = null;

export function registerBrowserHandler(handler: BrowserExecutionHandler): void {
  registeredBrowserHandler = handler;
}

export const browserTool: ToolDefinition<BrowserInput, BrowserToolOutput> = {
  description:
    "Interactive browser tool for navigating web pages, clicking elements, typing into forms, selecting dropdowns, scrolling, capturing screenshots, and downloading files. Uses accessibility-driven element references (e.g. 'e1', 'e2') for accurate interaction.",
  name: BROWSER_TOOL_NAME,
  parallelSafe: false,
  parameters: jsonSchemaFromZod(browserInputSchema),
  async run(input, context) {
    const parsed = browserInputSchema.parse(input);

    if (registeredBrowserHandler) {
      return registeredBrowserHandler(parsed, context);
    }

    throw new Error(
      "Interactive browser runtime is not initialized on this server."
    );
  },
};
