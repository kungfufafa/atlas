import { describe, expect, test } from "bun:test";
import type { ArtifactFile } from "@atlas/core/contract";
import {
  artifactBasename,
  artifactFolderSegments,
  filterArtifactFolderMetadata,
  listArtifactsInFolder,
  normalizeArtifactFolderPrefix,
} from "./files-artifact-folders";

function artifact(
  filename: string,
  updatedAt = "2026-08-19T00:00:00.000Z"
): ArtifactFile {
  return {
    filename,
    mimeType: "text/plain",
    path: `/tmp/${filename}`,
    sizeBytes: 1,
    updatedAt,
  };
}

describe("listArtifactsInFolder", () => {
  test("groups nested paths at the root", () => {
    const listing = listArtifactsInFolder(
      [
        artifact("zeta/old.log", "2026-08-01T00:00:00.000Z"),
        artifact("zeta/nested/new.log", "2026-08-20T00:00:00.000Z"),
        artifact("coding-agent-runs/a.log"),
        artifact("notes.md"),
      ],
      ""
    );

    expect(listing.folders.map((folder) => folder.name)).toEqual([
      "coding-agent-runs",
      "zeta",
    ]);
    expect(listing.folders[1]?.fileCount).toBe(2);
    expect(listing.folders[1]?.latestUpdatedAt).toBe(
      "2026-08-20T00:00:00.000Z"
    );
    expect(listing.files.map((file) => file.filename)).toEqual(["notes.md"]);
  });

  test("scopes to the exact current folder", () => {
    const listing = listArtifactsInFolder(
      [
        artifact("coding-agent-runs/a.log"),
        artifact("coding-agent-runs/nested/b.log"),
        artifact("coding-agent-runs-old/c.log"),
      ],
      "coding-agent-runs"
    );

    expect(listing.files.map((file) => file.filename)).toEqual([
      "coding-agent-runs/a.log",
    ]);
    expect(listing.folders.map((folder) => folder.name)).toEqual(["nested"]);
  });

  test("uses complete server folder metadata instead of the loaded file page", () => {
    const completeFolders = filterArtifactFolderMetadata(
      [
        {
          fileCount: 41,
          latestUpdatedAt: "2026-08-25T00:00:00.000Z",
          name: "reports",
          prefix: "reports",
          typeStats: {
            markdown: {
              fileCount: 40,
              latestUpdatedAt: "2026-08-25T00:00:00.000Z",
            },
            text: {
              fileCount: 1,
              latestUpdatedAt: "2026-08-20T00:00:00.000Z",
            },
          },
        },
      ],
      "markdown"
    );
    const listing = listArtifactsInFolder(
      [artifact("root-file.txt")],
      "",
      completeFolders
    );

    expect(listing.folders).toEqual([
      {
        fileCount: 40,
        latestUpdatedAt: "2026-08-25T00:00:00.000Z",
        name: "reports",
        prefix: "reports",
      },
    ]);
    expect(listing.files.map((file) => file.filename)).toEqual([
      "root-file.txt",
    ]);
  });

  test("normalizes separators and rejects traversal segments", () => {
    expect(normalizeArtifactFolderPrefix("/reports//weekly/")).toBe(
      "reports/weekly"
    );
    expect(normalizeArtifactFolderPrefix("reports\\weekly")).toBe(
      "reports/weekly"
    );
    expect(normalizeArtifactFolderPrefix("reports/../private")).toBe("");
  });

  test("builds safe breadcrumbs and basenames", () => {
    expect(artifactFolderSegments("reports/weekly")).toEqual([
      { name: "reports", prefix: "reports" },
      { name: "weekly", prefix: "reports/weekly" },
    ]);
    expect(artifactBasename("reports\\weekly\\summary.md")).toBe("summary.md");
  });
});
