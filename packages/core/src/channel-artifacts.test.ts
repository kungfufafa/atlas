import { describe, expect, test } from "bun:test";
import {
  channelArtifactRefFromArtifact,
  extractLatestTurnMessages,
  extractPairedTurnArtifacts,
  extractSessionArtifacts,
  extractTurnDeliverableArtifacts,
} from "./channel-artifacts";
import type { ChatMessage } from "./contract";

const ARTIFACTS_ROOT =
  "/Users/test/.atlas/orgs/org_1/profiles/profile_1/artifacts";

const metaJson = JSON.stringify({
  mimeType: "text/markdown",
  savedAt: "2026-07-13T10:00:00.000Z",
  sizeBytes: 42,
});

function assistantWithToolCalls(
  toolCalls: ChatMessage extends infer M
    ? M extends { role: "assistant"; toolCalls?: infer T }
      ? NonNullable<T>
      : never
    : never
): ChatMessage {
  return {
    content: "",
    role: "assistant",
    toolCalls,
  };
}

function toolMessage(input: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}): ChatMessage {
  return {
    content: JSON.stringify(input.result),
    name: input.name,
    role: "tool",
    toolCallId: input.id,
  };
}

describe("extractPairedTurnArtifacts", () => {
  test("pairs content and sidecar writes into one artifact ref", () => {
    const contentPath = `${ARTIFACTS_ROOT}/report.md`;
    const sidecarPath = `${ARTIFACTS_ROOT}/report.md.atlas-meta.json`;

    const messages: ChatMessage[] = [
      { content: "save report", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { content: "# Report", path: "artifacts/report.md" },
          id: "tool_1",
          name: "write_file",
        },
        {
          arguments: {
            content: metaJson,
            path: "artifacts/report.md.atlas-meta.json",
          },
          id: "tool_2",
          name: "write_file",
        },
      ]),
      toolMessage({
        id: "tool_1",
        input: { content: "# Report", path: "artifacts/report.md" },
        name: "write_file",
        result: { bytesWritten: 8, path: contentPath },
      }),
      toolMessage({
        id: "tool_2",
        input: {
          content: metaJson,
          path: "artifacts/report.md.atlas-meta.json",
        },
        name: "write_file",
        result: { bytesWritten: metaJson.length, path: sidecarPath },
      }),
      { content: "Saved the report.", role: "assistant" },
    ];

    expect(extractPairedTurnArtifacts(messages)).toEqual([
      {
        filename: "report.md",
        mimeType: "text/markdown",
        path: "report.md",
        savedAt: "2026-07-13T10:00:00.000Z",
        sizeBytes: 42,
      },
    ]);
  });

  test("returns empty when content write has no sidecar", () => {
    const contentPath = `${ARTIFACTS_ROOT}/draft.md`;

    expect(
      extractPairedTurnArtifacts([
        { content: "save", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { content: "draft", path: "artifacts/draft.md" },
            id: "tool_1",
            name: "write_file",
          },
        ]),
        toolMessage({
          id: "tool_1",
          input: { content: "draft", path: "artifacts/draft.md" },
          name: "write_file",
          result: { bytesWritten: 5, path: contentPath },
        }),
      ])
    ).toEqual([]);
  });

  test("ignores failed writes", () => {
    expect(
      extractPairedTurnArtifacts([
        { content: "save", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { content: "# Report", path: "artifacts/report.md" },
            id: "tool_1",
            name: "write_file",
          },
        ]),
        toolMessage({
          id: "tool_1",
          input: { content: "# Report", path: "artifacts/report.md" },
          name: "write_file",
          result: { error: "permission denied" },
        }),
      ])
    ).toEqual([]);
  });

  test("ignores writes outside artifacts/", () => {
    expect(
      extractPairedTurnArtifacts([
        { content: "save", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { content: "hello", path: "notes.txt" },
            id: "tool_1",
            name: "write_file",
          },
        ]),
        toolMessage({
          id: "tool_1",
          input: { content: "hello", path: "notes.txt" },
          name: "write_file",
          result: { bytesWritten: 5, path: "/tmp/notes.txt" },
        }),
      ])
    ).toEqual([]);
  });

  test("supports multiple pairs in one turn", () => {
    const messages: ChatMessage[] = [
      { content: "save both", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { content: "a", path: "artifacts/a.md" },
          id: "tool_1",
          name: "write_file",
        },
        {
          arguments: {
            content: metaJson,
            path: "artifacts/a.md.atlas-meta.json",
          },
          id: "tool_2",
          name: "write_file",
        },
        {
          arguments: { content: "b", path: "artifacts/b.md" },
          id: "tool_3",
          name: "write_file",
        },
        {
          arguments: {
            content: metaJson,
            path: "artifacts/b.md.atlas-meta.json",
          },
          id: "tool_4",
          name: "write_file",
        },
      ]),
      toolMessage({
        id: "tool_1",
        input: { content: "a", path: "artifacts/a.md" },
        name: "write_file",
        result: { bytesWritten: 1, path: `${ARTIFACTS_ROOT}/a.md` },
      }),
      toolMessage({
        id: "tool_2",
        input: { content: metaJson, path: "artifacts/a.md.atlas-meta.json" },
        name: "write_file",
        result: {
          bytesWritten: metaJson.length,
          path: `${ARTIFACTS_ROOT}/a.md.atlas-meta.json`,
        },
      }),
      toolMessage({
        id: "tool_3",
        input: { content: "b", path: "artifacts/b.md" },
        name: "write_file",
        result: { bytesWritten: 1, path: `${ARTIFACTS_ROOT}/b.md` },
      }),
      toolMessage({
        id: "tool_4",
        input: { content: metaJson, path: "artifacts/b.md.atlas-meta.json" },
        name: "write_file",
        result: {
          bytesWritten: metaJson.length,
          path: `${ARTIFACTS_ROOT}/b.md.atlas-meta.json`,
        },
      }),
    ];

    expect(
      extractPairedTurnArtifacts(messages).map((artifact) => artifact.path)
    ).toEqual(["a.md", "b.md"]);
  });

  test("extracts successful generate_image tool results without write_file pairs", () => {
    expect(
      extractPairedTurnArtifacts([
        { content: "draw a cat", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { prompt: "a cat" },
            id: "tool_img",
            name: "generate_image",
          },
        ]),
        toolMessage({
          id: "tool_img",
          input: { prompt: "a cat" },
          name: "generate_image",
          result: {
            attachmentId: "att_1",
            mimeType: "image/png",
            model: "gpt-image-2",
            path: "artifacts/cat.png",
            sizeBytes: 2048,
          },
        }),
        { content: "Here is your cat.", role: "assistant" },
      ])
    ).toEqual([
      {
        filename: "cat.png",
        mimeType: "image/png",
        path: "cat.png",
        savedAt: "",
        sizeBytes: 2048,
      },
    ]);
  });

  test("ignores failed generate_image tool results", () => {
    expect(
      extractPairedTurnArtifacts([
        { content: "draw", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { prompt: "a cat" },
            id: "tool_img",
            name: "generate_image",
          },
        ]),
        toolMessage({
          id: "tool_img",
          input: { prompt: "a cat" },
          name: "generate_image",
          result: { error: "Image model is not configured." },
        }),
      ])
    ).toEqual([]);
  });

  test("rejects generate_image results missing mimeType", () => {
    expect(
      extractPairedTurnArtifacts([
        { content: "draw", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { prompt: "a cat" },
            id: "tool_img",
            name: "generate_image",
          },
        ]),
        toolMessage({
          id: "tool_img",
          input: { prompt: "a cat" },
          name: "generate_image",
          result: {
            path: "artifacts/cat.png",
            sizeBytes: 2048,
          },
        }),
      ])
    ).toEqual([]);
  });

  test("rejects generate_image paths outside artifacts/", () => {
    expect(
      extractPairedTurnArtifacts([
        { content: "draw", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { prompt: "a cat" },
            id: "tool_img",
            name: "generate_image",
          },
        ]),
        toolMessage({
          id: "tool_img",
          input: { prompt: "a cat" },
          name: "generate_image",
          result: {
            mimeType: "image/png",
            path: "tmp/cat.png",
            sizeBytes: 2048,
          },
        }),
      ])
    ).toEqual([]);
  });

  test("keeps oversized generate_image refs with their sizeBytes for channel policy", () => {
    const oversized = 6 * 1024 * 1024;
    expect(
      extractPairedTurnArtifacts([
        { content: "draw", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { prompt: "huge" },
            id: "tool_img",
            name: "generate_image",
          },
        ]),
        toolMessage({
          id: "tool_img",
          input: { prompt: "huge" },
          name: "generate_image",
          result: {
            mimeType: "image/png",
            path: "artifacts/huge.png",
            sizeBytes: oversized,
          },
        }),
      ])
    ).toEqual([
      {
        filename: "huge.png",
        mimeType: "image/png",
        path: "huge.png",
        savedAt: "",
        sizeBytes: oversized,
      },
    ]);
  });

  test("extracts write_file pairs and generate_image together in one turn", () => {
    const messages: ChatMessage[] = [
      { content: "save and draw", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { content: "a", path: "artifacts/a.md" },
          id: "tool_1",
          name: "write_file",
        },
        {
          arguments: {
            content: metaJson,
            path: "artifacts/a.md.atlas-meta.json",
          },
          id: "tool_2",
          name: "write_file",
        },
        {
          arguments: { prompt: "a cat" },
          id: "tool_img",
          name: "generate_image",
        },
      ]),
      toolMessage({
        id: "tool_1",
        input: { content: "a", path: "artifacts/a.md" },
        name: "write_file",
        result: { bytesWritten: 1, path: `${ARTIFACTS_ROOT}/a.md` },
      }),
      toolMessage({
        id: "tool_2",
        input: { content: metaJson, path: "artifacts/a.md.atlas-meta.json" },
        name: "write_file",
        result: {
          bytesWritten: metaJson.length,
          path: `${ARTIFACTS_ROOT}/a.md.atlas-meta.json`,
        },
      }),
      toolMessage({
        id: "tool_img",
        input: { prompt: "a cat" },
        name: "generate_image",
        result: {
          attachmentId: "att_1",
          mimeType: "image/png",
          model: "gpt-image-2",
          path: "artifacts/cat.png",
          sizeBytes: 2048,
        },
      }),
    ];

    expect(
      extractPairedTurnArtifacts(messages).map((artifact) => artifact.path)
    ).toEqual(["a.md", "cat.png"]);
  });
});

describe("extractTurnDeliverableArtifacts", () => {
  test("uses streamed artifacts when persisted tool history is unavailable", () => {
    const streamed = channelArtifactRefFromArtifact({
      createdAt: "2026-08-25T10:00:00.000Z",
      filename: "analysis.pdf",
      id: "artifact_1",
      mimeType: "application/pdf",
      path: "artifacts/analysis.pdf",
      size: 4096,
      type: "pdf",
    });

    expect(streamed).not.toBeNull();
    expect(
      extractTurnDeliverableArtifacts(
        [
          { content: "create a report", role: "user" },
          { content: "Done", role: "assistant" },
        ],
        streamed ? [streamed] : []
      )
    ).toEqual([
      {
        filename: "analysis.pdf",
        mimeType: "application/pdf",
        path: "analysis.pdf",
        savedAt: "2026-08-25T10:00:00.000Z",
        sizeBytes: 4096,
      },
    ]);
  });

  test("keeps persisted artifact metadata when the stream reports the same path", () => {
    const contentPath = `${ARTIFACTS_ROOT}/report.bin`;
    const sidecarPath = `${contentPath}.atlas-meta.json`;
    const persistedMeta = JSON.stringify({
      mimeType: "application/pdf",
      savedAt: "2026-08-25T09:00:00.000Z",
      sizeBytes: 42,
    });

    const artifacts = extractTurnDeliverableArtifacts(
      [
        { content: "save", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { content: "pdf", path: "artifacts/report.bin" },
            id: "tool_1",
            name: "write_file",
          },
          {
            arguments: {
              content: persistedMeta,
              path: "artifacts/report.bin.atlas-meta.json",
            },
            id: "tool_2",
            name: "write_file",
          },
        ]),
        toolMessage({
          id: "tool_1",
          input: { content: "pdf", path: "artifacts/report.bin" },
          name: "write_file",
          result: { bytesWritten: 3, path: contentPath },
        }),
        toolMessage({
          id: "tool_2",
          input: {
            content: persistedMeta,
            path: "artifacts/report.bin.atlas-meta.json",
          },
          name: "write_file",
          result: { bytesWritten: persistedMeta.length, path: sidecarPath },
        }),
      ],
      [
        {
          filename: "report.bin",
          mimeType: "application/octet-stream",
          path: "report.bin",
          savedAt: "2026-08-25T10:00:00.000Z",
          sizeBytes: 3,
        },
      ]
    );

    expect(artifacts).toEqual([
      {
        filename: "report.bin",
        mimeType: "application/pdf",
        path: "report.bin",
        savedAt: "2026-08-25T09:00:00.000Z",
        sizeBytes: 42,
      },
    ]);
  });

  test("includes browser screenshot artifacts from the tool payload", () => {
    const artifacts = extractTurnDeliverableArtifacts([
      { content: "check the site", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { action: "screenshot" },
          id: "tool_1",
          name: "browser",
        },
      ]),
      toolMessage({
        id: "tool_1",
        input: { action: "screenshot" },
        name: "browser",
        result: {
          action: "screenshot",
          artifacts: [
            {
              createdAt: "2026-08-21T12:00:00.000Z",
              filename: "screenshot_1.png",
              mimeType: "image/png",
              path: "artifacts/screenshot_1.png",
              sizeBytes: 2048,
            },
          ],
          status: "success",
        },
      }),
    ]);

    expect(artifacts).toEqual([
      expect.objectContaining({
        filename: "screenshot_1.png",
        mimeType: "image/png",
        path: "screenshot_1.png",
        sizeBytes: 2048,
      }),
    ]);
  });

  test("includes unpaired write_file artifacts without a sidecar", () => {
    const artifacts = extractTurnDeliverableArtifacts([
      { content: "save", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { content: "draft", path: "artifacts/draft.md" },
          id: "tool_1",
          name: "write_file",
        },
      ]),
      toolMessage({
        id: "tool_1",
        input: { content: "draft", path: "artifacts/draft.md" },
        name: "write_file",
        result: { bytesWritten: 5, path: `${ARTIFACTS_ROOT}/draft.md` },
      }),
    ]);

    expect(artifacts).toEqual([
      expect.objectContaining({
        filename: "draft.md",
        mimeType: "text/markdown",
        path: "draft.md",
        sizeBytes: 5,
      }),
    ]);
  });

  test("includes spreadsheet create output", () => {
    const artifacts = extractTurnDeliverableArtifacts([
      { content: "make a sheet", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { action: "create", path: "artifacts/sales.xlsx" },
          id: "tool_1",
          name: "spreadsheet",
        },
      ]),
      toolMessage({
        id: "tool_1",
        input: { action: "create", path: "artifacts/sales.xlsx" },
        name: "spreadsheet",
        result: { path: "artifacts/sales.xlsx", status: "created" },
      }),
    ]);

    expect(artifacts).toEqual([
      expect.objectContaining({
        filename: "sales.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        path: "sales.xlsx",
      }),
    ]);
  });

  test("includes write_pptx output", () => {
    const artifacts = extractTurnDeliverableArtifacts([
      { content: "make a deck", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { path: "artifacts/deck.pptx", title: "Deck" },
          id: "tool_1",
          name: "write_pptx",
        },
      ]),
      toolMessage({
        id: "tool_1",
        input: { path: "artifacts/deck.pptx", title: "Deck" },
        name: "write_pptx",
        result: {
          bytesWritten: 4096,
          path: `${ARTIFACTS_ROOT}/deck.pptx`,
          slideCount: 4,
        },
      }),
    ]);

    expect(artifacts).toEqual([
      expect.objectContaining({
        filename: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        path: "deck.pptx",
        sizeBytes: 4096,
      }),
    ]);
  });

  test("skips writes outside artifacts/", () => {
    expect(
      extractTurnDeliverableArtifacts([
        { content: "update soul", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { content: "x", path: "SOUL.md" },
            id: "tool_1",
            name: "write_file",
          },
        ]),
        toolMessage({
          id: "tool_1",
          input: { content: "x", path: "SOUL.md" },
          name: "write_file",
          result: {
            bytesWritten: 1,
            path: "/home/.atlas/orgs/org/profiles/default/SOUL.md",
          },
        }),
      ])
    ).toEqual([]);
  });

  test("includes spreadsheet export_csv output from targetCsvPath", () => {
    const artifacts = extractTurnDeliverableArtifacts([
      { content: "export csv", role: "user" },
      assistantWithToolCalls([
        {
          arguments: {
            action: "export_csv",
            path: "artifacts/sales.xlsx",
            targetCsvPath: "artifacts/sales.csv",
          },
          id: "tool_1",
          name: "spreadsheet",
        },
      ]),
      toolMessage({
        id: "tool_1",
        input: {
          action: "export_csv",
          path: "artifacts/sales.xlsx",
          targetCsvPath: "artifacts/sales.csv",
        },
        name: "spreadsheet",
        result: {
          status: "csv_exported",
          targetCsvPath: "artifacts/sales.csv",
        },
      }),
    ]);

    expect(artifacts).toEqual([
      expect.objectContaining({
        filename: "sales.csv",
        mimeType: "text/csv",
        path: "sales.csv",
      }),
    ]);
  });

  test("skips spreadsheet inspect", () => {
    expect(
      extractTurnDeliverableArtifacts([
        { content: "inspect", role: "user" },
        assistantWithToolCalls([
          {
            arguments: { action: "inspect", path: "artifacts/sales.xlsx" },
            id: "tool_1",
            name: "spreadsheet",
          },
        ]),
        toolMessage({
          id: "tool_1",
          input: { action: "inspect", path: "artifacts/sales.xlsx" },
          name: "spreadsheet",
          result: { path: "artifacts/sales.xlsx", sheetCount: 1 },
        }),
      ])
    ).toEqual([]);
  });

  test("keeps paired sidecar mime type instead of inferring", () => {
    const contentPath = `${ARTIFACTS_ROOT}/report.md`;
    const sidecarPath = `${ARTIFACTS_ROOT}/report.md.atlas-meta.json`;

    const artifacts = extractTurnDeliverableArtifacts([
      { content: "save report", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { content: "# Report", path: "artifacts/report.md" },
          id: "tool_1",
          name: "write_file",
        },
        {
          arguments: {
            content: metaJson,
            path: "artifacts/report.md.atlas-meta.json",
          },
          id: "tool_2",
          name: "write_file",
        },
      ]),
      toolMessage({
        id: "tool_1",
        input: { content: "# Report", path: "artifacts/report.md" },
        name: "write_file",
        result: { bytesWritten: 8, path: contentPath },
      }),
      toolMessage({
        id: "tool_2",
        input: {
          content: metaJson,
          path: "artifacts/report.md.atlas-meta.json",
        },
        name: "write_file",
        result: { bytesWritten: metaJson.length, path: sidecarPath },
      }),
    ]);

    expect(artifacts).toEqual([
      {
        filename: "report.md",
        mimeType: "text/markdown",
        path: "report.md",
        savedAt: "2026-07-13T10:00:00.000Z",
        sizeBytes: 42,
      },
    ]);
  });
});

describe("extractLatestTurnMessages", () => {
  test("slices from the last user message", () => {
    const messages: ChatMessage[] = [
      { content: "first", role: "user" },
      { content: "one", role: "assistant" },
      { content: "second", role: "user" },
      { content: "two", role: "assistant" },
    ];

    expect(extractLatestTurnMessages(messages)).toEqual([
      { content: "second", role: "user" },
      { content: "two", role: "assistant" },
    ]);
  });
});

describe("extractSessionArtifacts", () => {
  test("collects proven artifact paths across every turn", () => {
    const messages: ChatMessage[] = [
      { content: "first", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { content: "one", path: "artifacts/first.md" },
          id: "tool_first",
          name: "write_file",
        },
      ]),
      toolMessage({
        id: "tool_first",
        input: { content: "one", path: "artifacts/first.md" },
        name: "write_file",
        result: {
          bytesWritten: 3,
          path: `${ARTIFACTS_ROOT}/first.md`,
        },
      }),
      { content: "second", role: "user" },
      assistantWithToolCalls([
        {
          arguments: { content: "two", path: "artifacts/second.md" },
          id: "tool_second",
          name: "write_file",
        },
      ]),
      toolMessage({
        id: "tool_second",
        input: { content: "two", path: "artifacts/second.md" },
        name: "write_file",
        result: {
          bytesWritten: 3,
          path: `${ARTIFACTS_ROOT}/second.md`,
        },
      }),
    ];

    expect(
      extractSessionArtifacts(messages).map((artifact) => artifact.path)
    ).toEqual(["first.md", "second.md"]);
  });
});
