import { expect, test } from "bun:test";
import { base64ByteLength, scaleImageDimensions } from "./compress-image-size";

test("counts decoded base64 bytes", () => {
  expect(base64ByteLength("AQID")).toBe(3);
  expect(base64ByteLength("AQIDBA==")).toBe(4);
});

test("fits the longest edge into the max dimension", () => {
  expect(scaleImageDimensions(4096, 2048, 2048)).toEqual({
    height: 1024,
    width: 2048,
  });
  expect(scaleImageDimensions(800, 600, 2048)).toEqual({
    height: 600,
    width: 800,
  });
});
