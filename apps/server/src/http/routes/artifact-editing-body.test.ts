import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_EDIT_MAX_HTTP_BODY_BYTES,
  parseArtifactEditRequest,
  readArtifactEditJsonBody,
} from "./artifact-editing-body";

describe("readArtifactEditJsonBody", () => {
  test("rejects a declared oversized request before reading the body", async () => {
    const request = new Request("http://localhost/edit", {
      body: "{}",
      headers: {
        "Content-Length": String(ARTIFACT_EDIT_MAX_HTTP_BODY_BYTES + 1),
        "Content-Type": "application/json",
      },
      method: "PUT",
    });

    await expect(readArtifactEditJsonBody(request)).rejects.toMatchObject({
      status: 413,
    });
  });

  test("rejects chunked oversized bodies and malformed UTF-8", async () => {
    const oversized = new Request("http://localhost/edit", {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array(ARTIFACT_EDIT_MAX_HTTP_BODY_BYTES + 1)
          );
          controller.close();
        },
      }),
      duplex: "half",
      method: "PUT",
    } as RequestInit);
    const malformed = new Request("http://localhost/edit", {
      body: new Uint8Array([0xc3, 0x28]),
      method: "PUT",
    });

    await expect(readArtifactEditJsonBody(oversized)).rejects.toMatchObject({
      status: 413,
    });
    await expect(readArtifactEditJsonBody(malformed)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("parseArtifactEditRequest", () => {
  test("accepts bounded request shapes for Markdown and tables", () => {
    expect(
      parseArtifactEditRequest({
        content: "# Updated",
        expectedHash: "a".repeat(64),
      })
    ).toEqual({
      content: "# Updated",
      expectedHash: "a".repeat(64),
      rows: undefined,
    });
    expect(
      parseArtifactEditRequest({
        expectedHash: "b".repeat(64),
        rows: [["Name"]],
      })
    ).toEqual({
      content: undefined,
      expectedHash: "b".repeat(64),
      rows: [["Name"]],
    });
  });

  test("rejects null, arrays, and invalid top-level field types", () => {
    const invalidBodies: unknown[] = [
      null,
      [],
      {},
      { content: 1, expectedHash: "a".repeat(64) },
      { expectedHash: 1 },
      { expectedHash: "not-a-sha-256" },
      { expectedHash: "a".repeat(64), rows: "not rows" },
    ];

    for (const body of invalidBodies) {
      expect(() => parseArtifactEditRequest(body)).toThrow();
      try {
        parseArtifactEditRequest(body);
      } catch (error) {
        expect(error).toMatchObject({ status: 400 });
      }
    }
  });
});
