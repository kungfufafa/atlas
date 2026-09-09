import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import dependency from "./file-markdown-dependency.json";

export async function verifyMarkdownDependency(
  directory = import.meta.dir
): Promise<void> {
  if (dependency.name !== "marked" || dependency.version !== "18.0.6") {
    throw new Error("Unexpected Markdown parser version.");
  }
  for (const [name, record] of Object.entries(dependency.files)) {
    const bytes = await readFile(join(directory, name));
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
      throw new Error("The declared Markdown parser dependency changed.");
    }
  }
}
