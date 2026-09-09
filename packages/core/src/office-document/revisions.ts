import type { Element } from "@xmldom/xmldom";
import { attribute, elements, nearestAncestor, WORD_NAMESPACES } from "./xml";

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const REVISION_NAMES = [
  "ins",
  "del",
  "moveFrom",
  "moveTo",
  "rPrChange",
  "pPrChange",
  "tblPrChange",
  "trPrChange",
  "tcPrChange",
  "sectPrChange",
  "tblGridChange",
  "numberingChange",
  "cellIns",
  "cellDel",
  "cellMerge",
];

export interface OfficeRevisionOptions {
  revisionAuthor?: string;
  trackChanges?: boolean;
}

export function isInsertedText(element: Element): boolean {
  return Boolean(nearestAncestor(element, "ins", WORD_NAMESPACES));
}

/** Record a replacement as new revisions; never rewrite another author's history.
 * OOXML permits nested run revisions, so rejecting Atlas's edits restores the
 * previous text and accepting/rejecting an outer insertion keeps its meaning.
 */
export class WordRevisionWriter {
  private nextId = 0;
  private readonly date = new Date().toISOString();

  constructor(
    roots: Element[],
    private readonly author = "Atlas"
  ) {
    for (const root of roots) {
      for (const name of REVISION_NAMES) {
        for (const revision of elements(root, name, WORD_NAMESPACES)) {
          const id = Number(attribute(revision, "id"));
          if (Number.isSafeInteger(id) && id >= this.nextId) {
            this.nextId = id + 1;
          }
        }
      }
    }
  }

  replace(element: Element, start: number, end: number, replacement: string) {
    const run = element.parentNode as Element | null;
    const owner = element.ownerDocument!;
    if (
      run?.localName !== "r" ||
      !WORD_NAMESPACES.has(run.namespaceURI ?? "") ||
      elements(run, "t", WORD_NAMESPACES).length !== 1 ||
      Array.from(run.childNodes).some(
        (child) =>
          child.nodeType === 1 &&
          !["rPr", "t"].includes((child as Element).localName ?? "")
      )
    ) {
      throw new Error(
        "Tracked replacement requires plain text runs; select text without embedded run content."
      );
    }
    const parent = run.parentNode!;
    const current = element.textContent ?? "";
    const namespace = run.namespaceURI!;
    const prefix = `${run.prefix || "w"}:`;
    const createRun = (text: string, deleted = false) => {
      const clone = run.cloneNode(true) as Element;
      const original = elements(clone, "t", WORD_NAMESPACES)[0]!;
      const value = owner.createElementNS(
        namespace,
        `${prefix}${deleted ? "delText" : "t"}`
      );
      value.textContent = text;
      value.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve");
      original.parentNode!.replaceChild(value, original);
      return clone;
    };
    const revise = (kind: "ins" | "del", text: string) => {
      const revision = owner.createElementNS(namespace, `${prefix}${kind}`);
      revision.setAttributeNS(namespace, `${prefix}id`, String(this.nextId++));
      revision.setAttributeNS(namespace, `${prefix}author`, this.author);
      revision.setAttributeNS(namespace, `${prefix}date`, this.date);
      revision.appendChild(createRun(text, kind === "del"));
      parent.insertBefore(revision, run);
    };
    if (start) {
      parent.insertBefore(createRun(current.slice(0, start)), run);
    }
    revise("del", current.slice(start, end));
    if (replacement) {
      revise("ins", replacement);
    }
    if (end < current.length) {
      parent.insertBefore(createRun(current.slice(end)), run);
    }
    parent.removeChild(run);
  }
}
