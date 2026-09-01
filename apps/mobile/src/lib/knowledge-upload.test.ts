import { describe, expect, test } from "bun:test";
import { AtlasApiError } from "@atlas/core/api-error";
import {
  formatKnowledgeBaseDuplicatePrompt,
  uploadKnowledgeBaseDocumentWithDuplicateResolution,
} from "./knowledge-upload";

function duplicateError(existingFilename = "existing.md"): AtlasApiError {
  return new AtlasApiError(
    "Document already exists",
    409,
    "/knowledge",
    undefined,
    {
      existingDocumentId: "document-1",
      existingFilename,
      match: "content_hash",
    }
  );
}

describe("knowledge base duplicate uploads", () => {
  test("names both documents when duplicate names differ", () => {
    expect(
      formatKnowledgeBaseDuplicatePrompt({
        existingDocumentId: "document-1",
        existingFilename: "existing.md",
        match: "content_hash",
        uploadedFilename: "new.md",
      })
    ).toBe(
      "The uploaded file “new.md” matches existing document “existing.md”. Replace it, or skip it?"
    );
  });

  test("retries a duplicate only after replace is selected", async () => {
    const calls: Array<string | undefined> = [];
    const result = await uploadKnowledgeBaseDocumentWithDuplicateResolution(
      "new.md",
      {
        decideDuplicate: async () => "replace",
        upload: async (onDuplicate) => {
          calls.push(onDuplicate);
          if (!onDuplicate) {
            throw duplicateError();
          }
          return "replaced";
        },
      }
    );

    expect(result).toBe("replaced");
    expect(calls).toEqual([undefined, "replace"]);
  });

  test("skip leaves the existing document unchanged", async () => {
    let uploadCount = 0;
    const result = await uploadKnowledgeBaseDocumentWithDuplicateResolution(
      "new.md",
      {
        decideDuplicate: async () => "skip",
        upload: async () => {
          uploadCount += 1;
          throw duplicateError();
        },
      }
    );

    expect(result).toBeNull();
    expect(uploadCount).toBe(1);
  });

  test("does not treat an unstructured conflict as a duplicate", async () => {
    const conflict = new AtlasApiError("Conflict", 409, "/knowledge");

    await expect(
      uploadKnowledgeBaseDocumentWithDuplicateResolution("new.md", {
        decideDuplicate: async () => "replace",
        upload: async () => {
          throw conflict;
        },
      })
    ).rejects.toBe(conflict);
  });
});
