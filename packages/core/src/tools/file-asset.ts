import { z } from "zod";
import type { ToolDefinition } from "../contract";
import {
  fileAssetRevision,
  loadFileAsset,
  MAX_FILE_ASSET_BYTES,
  saveFileArtifact,
} from "../files/assets";
import { jsonSchemaFromZod, parseToolInput } from "./schema";

const schema = z
  .object({
    documentRef: z.string().trim().min(1),
    operation: z.enum(["inspect", "materialize"]),
    outputFilename: z.string().optional(),
  })
  .strict();

export const fileAssetTool: ToolDefinition = {
  description:
    "Inspect an original chat attachment (att_...) or workspace file, or materialize its exact bytes as a working source copy for spreadsheet, Python, and other file tools. Never overwrites the source. Return paths are relative to the profile workspace; materialized inputs are not automatically sent as deliverables.",
  name: "file_asset",
  parameters: jsonSchemaFromZod(schema),
  async run(raw, context) {
    const input = parseToolInput(schema, raw);
    const asset = await loadFileAsset(input.documentRef, context, {
      maxBytes: MAX_FILE_ASSET_BYTES,
    });
    const metadata = {
      bytes: asset.bytes.length,
      filename: asset.filename,
      mediaType: asset.mediaType,
      revision: fileAssetRevision(asset.bytes),
    };
    if (input.operation === "inspect") {
      return metadata;
    }
    return {
      ...metadata,
      ...(await saveFileArtifact({
        bytes: asset.bytes,
        context,
        deliverable: false,
        filename: input.outputFilename ?? asset.filename,
        sourcePath: asset.sourcePath,
      })),
    };
  },
};
