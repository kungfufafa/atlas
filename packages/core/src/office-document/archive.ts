// biome-ignore-all lint/suspicious/noBitwiseOperators: ZIP flags and CRC32 require binary arithmetic.
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { zipSync } from "fflate";
import { attribute, elements, parseXml } from "./xml";

export const MAX_OFFICE_BYTES = 40 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 120 * 1024 * 1024;
const MAX_PART_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_COMPRESSION_RATIO = 1000;
const OFFICE_RELATIONSHIP = /\/officeDocument$/;
const FORBIDDEN_PART = /(^_xmlsignatures\/|vba(project|data)|\.vba$)/i;
const SIGNATURE_PART = /^_xmlsignatures\//i;
const FORBIDDEN_CONTENT = /macroEnabled|vbaProject|digital-signature/i;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

interface ZipEntry {
  compressed: number;
  crc: number;
  dataStart: number;
  method: number;
  name: string;
  size: number;
}

export interface OfficeRelationship {
  external: boolean;
  id: string;
  target: string;
  type: string;
}

export interface OfficeArchive {
  format: "docx" | "pptx";
  mainPart: string;
  parts: Record<string, Uint8Array>;
  relationships: Map<string, OfficeRelationship[]>;
}

function fail(message: string): never {
  throw new Error(`Unsupported or invalid Office document: ${message}`);
}

function validatePartName(name: string): void {
  if (
    !name ||
    name.startsWith("/") ||
    /[\\:\0]/.test(name) ||
    name
      .split("/")
      .some(
        (part, index, parts) =>
          part === "." || part === ".." || (!part && index !== parts.length - 1)
      )
  ) {
    fail("unsafe ZIP part path");
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function inspectZip(bytes: Uint8Array, allowMacros = false): ZipEntry[] {
  if (bytes.byteLength > MAX_OFFICE_BYTES || bytes.byteLength < 22) {
    fail("archive size exceeds the supported limit or is not a ZIP");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  const minimum = Math.max(0, end - 65_535);
  while (end >= minimum) {
    if (
      view.getUint32(end, true) === 0x06_05_4b_50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.byteLength
    ) {
      break;
    }
    end -= 1;
  }
  if (end < minimum) {
    fail(
      "a regular ZIP is required; encrypted and legacy Office files are unsupported"
    );
  }
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    view.getUint32(end + 4, true) !== 0 ||
    view.getUint16(end + 8, true) !== count ||
    count > MAX_ENTRIES ||
    directoryOffset + directorySize !== end
  ) {
    fail("multipart, ZIP64, excessive, or malformed archive directory");
  }
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  let total = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02_01_4b_50) {
      fail("malformed central directory");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      local + 30 > directoryOffset ||
      flags & 0x20_41 ||
      (method !== 0 && method !== 8) ||
      view.getUint16(cursor + 34, true) !== 0
    ) {
      fail("encrypted or unsupported ZIP entry");
    }
    const unixType = (view.getUint32(cursor + 38, true) >>> 16) & 0xf0_00;
    if (unixType !== 0 && unixType !== 0x80_00 && unixType !== 0x40_00) {
      fail("ZIP symbolic links or special files are unsupported");
    }
    const name = UTF8.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    );
    validatePartName(name);
    if (
      names.has(name) ||
      SIGNATURE_PART.test(name) ||
      (!allowMacros && FORBIDDEN_PART.test(name))
    ) {
      fail("duplicate, digitally signed, or macro-bearing ZIP part");
    }
    names.add(name);
    total += size;
    if (
      size > MAX_PART_BYTES ||
      total > MAX_EXPANDED_BYTES ||
      size / Math.max(1, compressed) > MAX_COMPRESSION_RATIO
    ) {
      fail("ZIP expansion exceeds safety limits");
    }
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (
      view.getUint32(local, true) !== 0x04_03_4b_50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method ||
      dataStart + compressed > directoryOffset ||
      UTF8.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !==
        name
    ) {
      fail("mismatched ZIP local header");
    }
    ranges.push({ end: dataStart + compressed, start: local });
    entries.push({
      compressed,
      crc: view.getUint32(cursor + 16, true),
      dataStart,
      method,
      name,
      size,
    });
    cursor = next;
  }
  if (cursor !== end) {
    fail("unexpected archive directory data");
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) {
      fail("overlapping ZIP entries");
    }
  }
  return entries;
}

function sourcePartForRelationships(name: string): string {
  if (name === "_rels/.rels") {
    return "";
  }
  const marker = name.lastIndexOf("/_rels/");
  if (marker < 0) {
    fail("invalid relationship part path");
  }
  return `${name.slice(0, marker)}/${name.slice(marker + 7, -5)}`;
}

function relationshipTarget(source: string, target: string): string {
  const decoded = decodeURIComponent(target.split("#")[0] ?? "");
  if (!decoded || /[\\:\0?]/.test(decoded)) {
    fail("invalid internal relationship target");
  }
  const resolved = decoded.startsWith("/")
    ? path.posix.normalize(decoded.slice(1))
    : path.posix.normalize(
        path.posix.join(path.posix.dirname(source), decoded)
      );
  validatePartName(resolved);
  return resolved;
}

export function readOfficeZipParts(
  bytes: Uint8Array,
  /** Only for passive importers that remove VBA before handing parts onward. */
  options: { allowMacros?: boolean } = {}
): Record<string, Uint8Array> {
  const entries = inspectZip(bytes, options.allowMacros);
  const parts: Record<string, Uint8Array> = Object.create(null);
  for (const entry of entries) {
    const compressed = bytes.subarray(
      entry.dataStart,
      entry.dataStart + entry.compressed
    );
    const data =
      entry.method === 0
        ? Uint8Array.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: Math.min(MAX_PART_BYTES, entry.size + 1),
          });
    if (!data || data.byteLength !== entry.size || crc32(data) !== entry.crc) {
      fail("ZIP part size or checksum mismatch");
    }
    parts[entry.name] = data;
    if (entry.name.endsWith(".xml") || entry.name.endsWith(".rels")) {
      parseXml(data, entry.name);
    }
  }
  return parts;
}

export function openOfficeArchive(bytes: Uint8Array): OfficeArchive {
  const parts = readOfficeZipParts(bytes);
  const types = parts["[Content_Types].xml"];
  if (!(types && parts["_rels/.rels"])) {
    fail("missing package content types or root relationships");
  }
  const typesDoc = parseXml(types, "[Content_Types].xml");
  if (
    typesDoc.documentElement.localName !== "Types" ||
    typesDoc.documentElement.namespaceURI !== CONTENT_TYPES_NAMESPACE ||
    FORBIDDEN_CONTENT.test(UTF8.decode(types))
  ) {
    fail("unsupported content types, macros, or signatures");
  }
  const relationships = new Map<string, OfficeRelationship[]>();
  for (const [name, data] of Object.entries(parts)) {
    if (!name.endsWith(".rels")) {
      continue;
    }
    const source = sourcePartForRelationships(name);
    if (source && !parts[source]) {
      fail("relationship source does not exist");
    }
    const xml = parseXml(data, name);
    if (
      xml.documentElement.localName !== "Relationships" ||
      xml.documentElement.namespaceURI !== PACKAGE_RELATIONSHIPS_NAMESPACE
    ) {
      fail("invalid relationships root");
    }
    const ids = new Set<string>();
    const items = elements(xml.documentElement, "Relationship").map(
      (element) => {
        const id = attribute(element, "Id");
        const type = attribute(element, "Type");
        const rawTarget = attribute(element, "Target");
        if (
          !id ||
          ids.has(id) ||
          !type ||
          !rawTarget ||
          FORBIDDEN_CONTENT.test(type)
        ) {
          fail("invalid, duplicate, macro, or signature relationship");
        }
        ids.add(id);
        const external = attribute(element, "TargetMode") === "External";
        const target = external
          ? rawTarget
          : relationshipTarget(source, rawTarget);
        if (!(external || parts[target])) {
          fail(`relationship references missing part ${target}`);
        }
        return { external, id, target, type };
      }
    );
    relationships.set(source, items);
  }
  const root = relationships
    .get("")
    ?.filter((item) => OFFICE_RELATIONSHIP.test(item.type));
  if (root?.length !== 1 || root[0]!.external) {
    fail("one internal Office document relationship is required");
  }
  const mainPart = root[0]!.target;
  const main = parseXml(parts[mainPart]!, mainPart).documentElement;
  const format =
    main.localName === "document"
      ? "docx"
      : main.localName === "presentation"
        ? "pptx"
        : null;
  if (!format) {
    fail("only Word documents and PowerPoint presentations are supported");
  }
  const mainType = elements(typesDoc.documentElement, "Override").find(
    (element) => attribute(element, "PartName") === `/${mainPart}`
  );
  const expectedType =
    format === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
  if (!mainType || attribute(mainType, "ContentType") !== expectedType) {
    fail("main part content type is not a standard .docx or .pptx document");
  }
  return { format, mainPart, parts, relationships };
}

export function saveOfficeArchive(archive: OfficeArchive): Uint8Array {
  const bytes = zipSync(archive.parts, { level: 6 });
  const roundTrip = openOfficeArchive(bytes);
  if (
    roundTrip.mainPart !== archive.mainPart ||
    roundTrip.format !== archive.format
  ) {
    fail("edited package failed round-trip validation");
  }
  return bytes;
}
