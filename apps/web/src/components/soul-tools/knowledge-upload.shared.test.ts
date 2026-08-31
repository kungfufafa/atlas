import { describe, expect, test } from "bun:test";
import { AtlasApiError } from "@atlas/core/api-error";
import type { KnowledgeBaseDuplicateAction } from "@atlas/core/contract";
import {
  formatKnowledgeBaseDuplicatePrompt,
  type PreparedKnowledgeBaseUpload,
  uploadPreparedKnowledgeBaseDocuments,
} from "./knowledge-upload.shared";

const ITEMS: PreparedKnowledgeBaseUpload[] = [
  {
    document: {
      data: "Zmlyc3Q=",
      filename: "first.md",
      mediaType: "text/markdown",
    },
    filename: "first.md",
  },
  {
    document: {
      data: "c2Vjb25k",
      filename: "second.md",
      mediaType: "text/markdown",
    },
    filename: "second.md",
  },
];

function duplicateError(existingFilename = "existing-first.md"): AtlasApiError {
  return new AtlasApiError("Duplicate document.", 409, undefined, undefined, {
    existingDocumentId: "kb_existing",
    existingFilename,
    match: "content_hash",
  });
}

describe("knowledge base duplicate uploads", () => {
  test("names the existing and uploaded documents in replacement prompts", () => {
    expect(
      formatKnowledgeBaseDuplicatePrompt({
        existingDocumentId: "kb_existing",
        existingFilename: "existing-guide.md",
        match: "content_hash",
        uploadedFilename: "new-guide.md",
      })
    ).toBe(
      "The uploaded file “new-guide.md” matches existing document “existing-guide.md”. Replace it, or skip it?"
    );
    expect(
      formatKnowledgeBaseDuplicatePrompt({
        existingDocumentId: "kb_existing",
        existingFilename: "guide.md",
        match: "name_size",
        uploadedFilename: "guide.md",
      })
    ).toBe(
      "Replace existing document “guide.md” with this upload, or skip it?"
    );
  });

  test("retries only the selected duplicate with replace", async () => {
    const calls: Array<{
      filename: string;
      onDuplicate?: KnowledgeBaseDuplicateAction;
    }> = [];

    await uploadPreparedKnowledgeBaseDocuments(ITEMS, {
      decideDuplicate: async (context) => {
        expect(context).toEqual({
          existingDocumentId: "kb_existing",
          existingFilename: "existing-first.md",
          match: "content_hash",
          uploadedFilename: "first.md",
        });
        return "replace";
      },
      upload: async (item, onDuplicate) => {
        calls.push({ filename: item.filename, onDuplicate });
        if (item.filename === "first.md" && onDuplicate === undefined) {
          throw duplicateError();
        }
      },
    });

    expect(calls).toEqual([
      { filename: "first.md", onDuplicate: undefined },
      { filename: "first.md", onDuplicate: "replace" },
      { filename: "second.md", onDuplicate: undefined },
    ]);
  });

  test("skip continues while cancel stops the remaining batch", async () => {
    const skippedCalls: string[] = [];
    await uploadPreparedKnowledgeBaseDocuments(ITEMS, {
      decideDuplicate: async () => "skip",
      upload: async (item) => {
        skippedCalls.push(item.filename);
        if (item.filename === "first.md") {
          throw duplicateError();
        }
      },
    });
    expect(skippedCalls).toEqual(["first.md", "second.md"]);

    const cancelledCalls: string[] = [];
    await uploadPreparedKnowledgeBaseDocuments(ITEMS, {
      decideDuplicate: async () => "cancel",
      upload: async (item) => {
        cancelledCalls.push(item.filename);
        throw duplicateError();
      },
    });
    expect(cancelledCalls).toEqual(["first.md"]);
  });

  test("stops on non-duplicate and replacement failures", async () => {
    const hardFailure = new AtlasApiError("Unavailable.", 503);
    await expect(
      uploadPreparedKnowledgeBaseDocuments(ITEMS, {
        decideDuplicate: async () => "replace",
        upload: async () => {
          throw hardFailure;
        },
      })
    ).rejects.toBe(hardFailure);

    const replaceFailure = new Error("Replacement failed.");
    await expect(
      uploadPreparedKnowledgeBaseDocuments(ITEMS, {
        decideDuplicate: async () => "replace",
        upload: async (_item, onDuplicate) => {
          if (onDuplicate === "replace") {
            throw replaceFailure;
          }
          throw duplicateError();
        },
      })
    ).rejects.toBe(replaceFailure);
  });

  test("does not treat an unstructured conflict as a duplicate", async () => {
    const conflict = new AtlasApiError("Profile changed.", 409);

    await expect(
      uploadPreparedKnowledgeBaseDocuments(ITEMS, {
        decideDuplicate: async () => "replace",
        upload: async () => {
          throw conflict;
        },
      })
    ).rejects.toBe(conflict);
  });
});
