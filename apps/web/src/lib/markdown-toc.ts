export type MarkdownHeading = {
  level: 1 | 2 | 3;
  /** Nth rendered heading carrying this exact text. */
  occurrence: number;
  /** Position among all h1–h3 headings, used when markup changes rendered text. */
  position: number;
  /** GitHub-style stable id, with numeric suffixes for duplicates. */
  slug: string;
  text: string;
};

/** A single heading is a title, not an outline worth separate navigation. */
export const MARKDOWN_TOC_MIN_HEADINGS = 2;
/** Keep pathological generated documents from creating thousands of buttons. */
export const MARKDOWN_TOC_MAX_HEADINGS = 100;

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_PATTERN = /^ {0,3}(#{1,3})(?:[ \t]+(.*)|[ \t]*)$/;
const SETEXT_HEADING_PATTERN = /^ {0,3}(=+|-+)[ \t]*$/;
const SETEXT_INELIGIBLE_PATTERN =
  /^ {0,3}(?:#|>|`{3,}|~{3,}|[-+*][ \t]|\d+[.)][ \t])/;
const CLOSING_HASHES_PATTERN = /[ \t]+#+[ \t]*$/;
const SLUG_INVALID_PATTERN = /[^\p{L}\p{M}\p{N}_\s-]/gu;
const SLUG_SEPARATOR_PATTERN = /[\s-]+/g;
const WHITESPACE_PATTERN = /\s+/g;

function decodeMarkdownEntities(value: string): string {
  return value.replace(
    /&(amp|apos|gt|lt|quot|#39|#x27);/gi,
    (entity, name: string) => {
      switch (name.toLowerCase()) {
        case "amp":
          return "&";
        case "apos":
        case "#39":
        case "#x27":
          return "'";
        case "gt":
          return ">";
        case "lt":
          return "<";
        case "quot":
          return '"';
        default:
          return entity;
      }
    }
  );
}

function plainMarkdownText(raw: string): string {
  return decodeMarkdownEntities(
    raw
      .replace(CLOSING_HASHES_PATTERN, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/<(https?:\/\/[^ >]+|mailto:[^ >]+)>/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/\\([\\`*{}[\]()#+.!_>~|-])/g, "$1")
      .replace(/[*_~`]/g, "")
  )
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}

function baseHeadingSlug(text: string): string {
  return (
    text
      .normalize("NFKD")
      .toLowerCase()
      .replace(SLUG_INVALID_PATTERN, "")
      .trim()
      .replace(SLUG_SEPARATOR_PATTERN, "-") || "section"
  );
}

function isSetextCandidate(line: string): boolean {
  return Boolean(
    line.trim() &&
      !line.startsWith("    ") &&
      !HEADING_PATTERN.test(line) &&
      !SETEXT_INELIGIBLE_PATTERN.test(line)
  );
}

export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const seen = new Map<string, number>();
  const seenSlugs = new Map<string, number>();
  let openFence: { length: number; marker: string } | null = null;
  let setextCandidate: string | null = null;

  const addHeading = (level: MarkdownHeading["level"], rawText: string) => {
    const text = plainMarkdownText(rawText);
    if (!text) {
      return;
    }

    const occurrence = seen.get(text) ?? 0;
    seen.set(text, occurrence + 1);
    const baseSlug = baseHeadingSlug(text);
    const slugOccurrence = seenSlugs.get(baseSlug) ?? 0;
    seenSlugs.set(baseSlug, slugOccurrence + 1);
    headings.push({
      level,
      occurrence,
      position: headings.length,
      slug: slugOccurrence === 0 ? baseSlug : `${baseSlug}-${slugOccurrence}`,
      text,
    });
  };

  for (const line of markdown.split("\n")) {
    const fence = FENCE_PATTERN.exec(line);
    if (openFence) {
      if (
        fence &&
        fence[1]?.[0] === openFence.marker &&
        fence[1].length >= openFence.length &&
        fence[2]?.trim() === ""
      ) {
        openFence = null;
      }
      setextCandidate = null;
      continue;
    }

    if (fence?.[1]) {
      openFence = { length: fence[1].length, marker: fence[1][0] ?? "" };
      setextCandidate = null;
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading?.[1]) {
      addHeading(
        heading[1].length as MarkdownHeading["level"],
        heading[2] ?? ""
      );
      setextCandidate = null;
    } else {
      const setext = SETEXT_HEADING_PATTERN.exec(line);
      if (setext?.[1] && setextCandidate !== null) {
        addHeading(setext[1][0] === "=" ? 1 : 2, setextCandidate);
        setextCandidate = null;
      } else {
        setextCandidate = isSetextCandidate(line) ? line : null;
      }
    }

    if (headings.length === MARKDOWN_TOC_MAX_HEADINGS) {
      break;
    }
  }

  return headings;
}

/** Resolve against rendered output so repeated headings still jump correctly. */
export function findHeadingElement(
  root: HTMLElement | null,
  heading: MarkdownHeading
): HTMLElement | null {
  if (!root) {
    return null;
  }

  const renderedHeadings = Array.from(
    root.querySelectorAll<HTMLElement>("h1, h2, h3")
  );
  const slugMatch = renderedHeadings.find(
    (element) => element.id === heading.slug
  );
  if (slugMatch) {
    return slugMatch;
  }

  const matches = renderedHeadings.filter(
    (element) =>
      element.textContent?.replace(WHITESPACE_PATTERN, " ").trim() ===
      heading.text
  );

  const exactMatch = matches[heading.occurrence];
  if (exactMatch) {
    return exactMatch;
  }

  const positionalMatch = renderedHeadings[heading.position];
  return positionalMatch?.tagName === `H${heading.level}`
    ? positionalMatch
    : null;
}
