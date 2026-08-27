import { describe, expect, test } from "bun:test";
import {
  type ImageAttachment,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_BYTES,
  validateImageAttachments,
} from "@atlas/core";
import {
  validateDecodedImageAttachments,
  validateGeneratedImageOutput,
} from "./image-decoder-validation";

const VALID_IMAGES: ImageAttachment[] = [
  {
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    mediaType: "image/png",
  },
  {
    data: "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z",
    mediaType: " IMAGE/JPG; charset=binary ",
  },
  {
    data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    mediaType: "image/gif",
  },
  {
    data: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
    mediaType: "image/webp",
  },
];

function corruptPng(image: ImageAttachment): ImageAttachment {
  const bytes = Buffer.from(image.data, "base64");
  const dataOffset = bytes.indexOf(Buffer.from("IDAT")) + 4;
  bytes[dataOffset] = 0xff - (bytes[dataOffset] ?? 0);
  return { data: bytes.toString("base64"), mediaType: "image/png" };
}

function corruptJpeg(image: ImageAttachment): ImageAttachment {
  const bytes = Buffer.from(image.data, "base64");
  const scanMarkerOffset = bytes.indexOf(Buffer.from([0xff, 0xda]));
  bytes[scanMarkerOffset + 4] = 0;
  return { data: bytes.toString("base64"), mediaType: "image/jpeg" };
}

function corruptGif(image: ImageAttachment): ImageAttachment {
  const bytes = Buffer.from(image.data, "base64");
  const corrupted = Buffer.concat([bytes.subarray(0, 13), Buffer.from([0x3b])]);
  return { data: corrupted.toString("base64"), mediaType: "image/gif" };
}

function corruptWebp(image: ImageAttachment): ImageAttachment {
  const corrupted = Buffer.from(
    Buffer.from(image.data, "base64").subarray(0, 30)
  );
  corrupted.writeUInt32LE(22, 4);
  corrupted.writeUInt32LE(10, 16);
  return { data: corrupted.toString("base64"), mediaType: "image/webp" };
}

describe("decoded image attachment validation", () => {
  test("fully decodes supported still-image formats", async () => {
    await expect(validateDecodedImageAttachments(VALID_IMAGES)).resolves.toBe(
      undefined
    );
  });

  const corruptionCases = [
    ["PNG", corruptPng(VALID_IMAGES[0]!)],
    ["JPEG", corruptJpeg(VALID_IMAGES[1]!)],
    ["GIF", corruptGif(VALID_IMAGES[2]!)],
    ["WebP", corruptWebp(VALID_IMAGES[3]!)],
  ] as const;

  for (const [format, image] of corruptionCases) {
    test(`rejects corrupt ${format} pixels that pass structural checks`, async () => {
      expect(() => validateImageAttachments([image])).not.toThrow();
      await expect(
        validateDecodedImageAttachments([image])
      ).rejects.toMatchObject({ status: 400 });
    });
  }

  const animatedImages = [
    {
      data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwALAAAAAABAAEAAAIBRAA7",
      format: "GIF",
      mediaType: "image/gif",
    },
    {
      data: "UklGRpQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAD/////AABBTk1GMAAAAAAAAAAAAAAAAAAAAGQAAAJWUDggGAAAADABAJ0BKgEAAQABQCYlpAADcAD+/PQAAEFOTUYwAAAAAAAAAAAAAAAAAAAAZAAAAFZQOCAYAAAANAEAnQEqAQABAAAAJiWkAANwAP79NmgA",
      format: "WebP",
      mediaType: "image/webp",
    },
    {
      data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAAEACgAA6FTcAAAAABBJREFUeJxj/MMAAixgkgEADQQBAr9QFbMAAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAAEACgAAwQzaBAAAABBmZEFUAAAAAnicY/zDwAAAAvwA/uU1kAgAAAAASUVORK5CYII=",
      format: "APNG",
      mediaType: "image/png",
    },
  ];

  for (const { data, format, mediaType } of animatedImages) {
    test(`rejects animated ${format} before decoding frames`, async () => {
      const image = { data, mediaType };
      expect(() => validateImageAttachments([image])).not.toThrow();
      await expect(
        validateDecodedImageAttachments([image])
      ).rejects.toMatchObject({ status: 400 });
    });
  }
});

describe("generated image output validation", () => {
  test("returns decoded dimensions for a valid still image", async () => {
    const png = VALID_IMAGES[0]!;
    await expect(
      validateGeneratedImageOutput(Buffer.from(png.data, "base64"), "image/png")
    ).resolves.toEqual({ height: 1, width: 1 });
  });

  test("allows generated output above the smaller upload limit", async () => {
    const png = Buffer.from(VALID_IMAGES[0]!.data, "base64");
    const paddedPng = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    png.copy(paddedPng);

    await expect(
      validateGeneratedImageOutput(paddedPng, "image/png")
    ).resolves.toEqual({ height: 1, width: 1 });
  });

  test("uses bad-gateway semantics for corrupt generated pixels", async () => {
    const corrupted = corruptPng(VALID_IMAGES[0]!);
    await expect(
      validateGeneratedImageOutput(
        Buffer.from(corrupted.data, "base64"),
        corrupted.mediaType
      )
    ).rejects.toMatchObject({ status: 502 });
  });

  test("uses bad-gateway semantics for MIME mismatches", async () => {
    const png = VALID_IMAGES[0]!;
    await expect(
      validateGeneratedImageOutput(
        Buffer.from(png.data, "base64"),
        "image/jpeg"
      )
    ).rejects.toMatchObject({ status: 502 });
  });

  test("rejects generated output beyond the 32 MiB limit", async () => {
    const oversized = new Uint8Array(MAX_GENERATED_IMAGE_BYTES + 1);
    await expect(
      validateGeneratedImageOutput(oversized, "image/png")
    ).rejects.toMatchObject({ status: 502 });
  });
});
