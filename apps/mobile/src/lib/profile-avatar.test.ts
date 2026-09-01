import { describe, expect, test } from "bun:test";
import {
  arrayBufferToAvatarUri,
  profileAvatarResizeActions,
  shouldPreserveAvatarTransparency,
} from "./profile-avatar";

describe("arrayBufferToAvatarUri", () => {
  test("creates an image data URI from avatar bytes", () => {
    const data = Uint8Array.from([137, 80, 78, 71]).buffer;

    expect(arrayBufferToAvatarUri(data, "image/png")).toBe(
      "data:image/png;base64,iVBORw=="
    );
  });

  test("uses a safe image type when the response type is not an image", () => {
    const data = Uint8Array.from([255, 216, 255]).buffer;

    expect(arrayBufferToAvatarUri(data, "application/octet-stream")).toBe(
      "data:image/png;base64,/9j/"
    );
  });
});

describe("profileAvatarResizeActions", () => {
  test("keeps small images at their original dimensions", () => {
    expect(profileAvatarResizeActions(320, 240)).toEqual([]);
  });

  test("limits the longest edge before crossing image bytes into JavaScript", () => {
    expect(profileAvatarResizeActions(4000, 3000)).toEqual([
      { resize: { height: 384, width: 512 } },
    ]);
  });
});

test("preserves transparency-capable avatar formats", () => {
  expect(shouldPreserveAvatarTransparency("image/png")).toBe(true);
  expect(shouldPreserveAvatarTransparency("image/webp")).toBe(true);
  expect(shouldPreserveAvatarTransparency("image/gif")).toBe(true);
  expect(shouldPreserveAvatarTransparency("image/jpeg")).toBe(false);
});
