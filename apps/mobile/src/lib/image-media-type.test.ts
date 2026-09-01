import { expect, test } from "bun:test";
import { resolvePickedImageMediaType } from "./image-media-type";

test("uses encoded bytes when Android picker MIME metadata is stale", () => {
  expect(resolvePickedImageMediaType("/9j/AA==", "image/png")).toBe(
    "image/jpeg"
  );
  expect(
    resolvePickedImageMediaType("iVBORw0KGgo=", "application/octet-stream")
  ).toBe("image/png");
});

test("keeps picker metadata when the image signature is unknown", () => {
  expect(resolvePickedImageMediaType("not-base64", "image/webp")).toBe(
    "image/webp"
  );
});
