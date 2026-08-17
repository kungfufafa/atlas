import { describe, expect, test } from "bun:test";
import {
  collectRelativeAssetPaths,
  htmlWithVirtualArtifactFiles,
  prettyPrintJson,
  resolveSiblingArtifactPath,
} from "./playable-html-preview";

describe("resolveSiblingArtifactPath", () => {
  test("resolves next to the html file", () => {
    expect(resolveSiblingArtifactPath("index.html", "data.json")).toBe(
      "data.json"
    );
    expect(resolveSiblingArtifactPath("app/index.html", "./data.json")).toBe(
      "app/data.json"
    );
  });

  test("rejects remote urls and parent escapes", () => {
    expect(
      resolveSiblingArtifactPath("index.html", "https://x.test/a.json")
    ).toBeNull();
    expect(
      resolveSiblingArtifactPath("index.html", "../secret.json")
    ).toBeNull();
  });
});

describe("collectRelativeAssetPaths", () => {
  test("finds src href and fetch targets", () => {
    expect(
      collectRelativeAssetPaths(
        `<script src="app.js"></script><link href="./style.css"><script>fetch("data.json")</script>`
      )
    ).toEqual(["app.js", "./style.css", "data.json"]);
  });
});

describe("prettyPrintJson", () => {
  test("formats objects and leaves invalid json alone", () => {
    expect(prettyPrintJson('{"a":1}')).toBe('{\n  "a": 1\n}\n');
    expect(prettyPrintJson("not-json")).toBe("not-json");
  });
});

describe("htmlWithVirtualArtifactFiles", () => {
  test("injects a fetch shim for bundled files", () => {
    const html = htmlWithVirtualArtifactFiles("<html><head></head></html>", {
      "data.json": '{"ok":true}',
    });
    expect(html).toContain("data-atlas-virtual-files");
    expect(html).toContain("data.json");
  });
});
