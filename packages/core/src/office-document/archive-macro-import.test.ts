import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { readOfficeZipParts } from "./archive";

test("passive VBA opt-in leaves default rejection and signature guards active", () => {
  const macro = zipSync({
    "xl/vbaProject.bin": Buffer.from("inert VBA bytes"),
  });
  expect(() => readOfficeZipParts(macro)).toThrow();
  expect(
    readOfficeZipParts(macro, { allowMacros: true })["xl/vbaProject.bin"]
  ).toEqual(new Uint8Array(Buffer.from("inert VBA bytes")));
  const signed = zipSync({
    "_xmlsignatures/origin.sigs": Buffer.from("signature"),
  });
  expect(() => readOfficeZipParts(signed, { allowMacros: true })).toThrow();
});

test("passive VBA opt-in still validates checksums and traversal", () => {
  const macro = Buffer.from(
    zipSync({ "xl/vbaProject.bin": Buffer.from("VBA_BYTES") }, { level: 0 })
  );
  const marker = macro.indexOf("VBA_BYTES");
  expect(marker).toBeGreaterThan(0);
  macro[marker] = 0;
  expect(() => readOfficeZipParts(macro, { allowMacros: true })).toThrow();
  expect(() =>
    readOfficeZipParts(
      zipSync({ "../xl/vbaProject.bin": Buffer.from("bytes") }),
      { allowMacros: true }
    )
  ).toThrow();
});
