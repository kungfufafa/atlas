import {
  DOMParser,
  type Document,
  type Element,
  type Node,
  XMLSerializer,
} from "@xmldom/xmldom";

const MAX_XML_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_XML = /<!DOCTYPE|<!ENTITY/i;
const ENCODING = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i;

export const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
export const DRAWING_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
export const PRESENTATION_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
]);

export type ParsedXmlDocument = Document & { documentElement: Element };

export function parseXml(bytes: Uint8Array, name: string): ParsedXmlDocument {
  if (bytes.byteLength > MAX_XML_BYTES) {
    throw new Error(`XML part exceeds the supported size: ${name}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const encoding = ENCODING.exec(text)?.[1];
  if (FORBIDDEN_XML.test(text) || (encoding && !/^utf-?8$/i.test(encoding))) {
    throw new Error(`DTD, entities, or unsupported XML encoding in ${name}`);
  }
  const problems: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => problems.push(`${level}: ${message}`),
  }).parseFromString(text, "application/xml");
  if (problems.length || !document.documentElement || document.doctype) {
    throw new Error(`Malformed XML part: ${name}`);
  }
  return document as ParsedXmlDocument;
}

export function serializeXml(document: Document): Uint8Array {
  // xmldom represents the XML declaration as a processing instruction, which
  // its strict serializer rejects. Preserve it separately while still applying
  // well-formedness checks to every document node we edit.
  const clone = document.cloneNode(true) as Document;
  const serializer = new XMLSerializer();
  let declaration = "";
  for (let node = clone.firstChild; node; ) {
    const next = node.nextSibling;
    if (node.nodeType === 7 && node.nodeName === "xml") {
      declaration += serializer.serializeToString(node);
      clone.removeChild(node);
    }
    node = next;
  }
  return new TextEncoder().encode(
    declaration +
      serializer.serializeToString(clone, { requireWellFormed: true })
  );
}

export function elements(
  root: Node,
  localName: string,
  namespaces?: ReadonlySet<string>
): Element[] {
  const result: Element[] = [];
  const pending: Node[] = [];
  for (let child = root.lastChild; child; child = child.previousSibling) {
    pending.push(child);
  }
  while (pending.length) {
    const node = pending.pop()!;
    if (node.nodeType === 1) {
      const element = node as Element;
      if (
        element.localName === localName &&
        (!namespaces || namespaces.has(element.namespaceURI ?? ""))
      ) {
        result.push(element);
      }
    }
    for (let child = node.lastChild; child; child = child.previousSibling) {
      pending.push(child);
    }
  }
  return result;
}

export function attribute(element: Element, localName: string): string {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attr = element.attributes.item(index);
    if (attr?.localName === localName) {
      return attr.value;
    }
  }
  return "";
}

export function nearestAncestor(
  element: Element,
  localName: string,
  namespaces: ReadonlySet<string>
): Element | null {
  let current = element.parentNode;
  while (current) {
    if (current.nodeType === 1) {
      const candidate = current as Element;
      if (
        candidate.localName === localName &&
        namespaces.has(candidate.namespaceURI ?? "")
      ) {
        return candidate;
      }
    }
    current = current.parentNode;
  }
  return null;
}
