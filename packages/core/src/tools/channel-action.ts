import { z } from "zod";
import { channelNativeActionSchema } from "../channel-native-actions";
import type { ToolDefinition } from "../contract";
import { jsonSchemaFromZod } from "./schema";

// Providers require an object root. The strict discriminated schema below still
// rejects cross-action fields and missing action-specific arguments before effects.
const fields: Record<string, z.ZodType> = {};
for (const option of channelNativeActionSchema.options) {
  Object.assign(fields, option.shape);
}
const declaration = z
  .object(fields)
  .partial()
  .extend({
    kind: z.enum(
      channelNativeActionSchema.options.map((option) => option.shape.kind.value)
    ),
  })
  .strict();

export const channelActionTool: ToolDefinition = {
  description:
    "Perform a native action in the current authorized messenger conversation. Supports reactions, polls, edits, deletes, pins, topics/threads and saved media when the channel permits them. Message mutations require a message belonging to this session. No arbitrary destination is accepted. Waits for the worker receipt: accepted means the platform acknowledged the action, not a recipient read receipt; unknown must not be retried automatically.",
  name: "channel_action",
  parameters: jsonSchemaFromZod(declaration),
  async run(input, context) {
    const action = channelNativeActionSchema.parse(input);
    if (!context.requestChannelAction) {
      throw new Error(
        "Native channel actions require an active messenger turn."
      );
    }
    return context.requestChannelAction(action, undefined, context.signal);
  },
};
