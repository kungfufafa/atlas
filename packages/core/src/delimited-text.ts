export type DelimitedTextDelimiter = "," | ";" | "\t";

export interface ParsedDelimitedText {
  columnCount: number;
  delimiter: DelimitedTextDelimiter;
  lineEnding: "\n" | "\r" | "\r\n";
  rowCount: number;
  rows: string[][];
  trailingNewline: boolean;
  truncated: boolean;
}

export interface ParseDelimitedTextOptions {
  allowIncompleteFinalRecord?: boolean;
  delimiter?: DelimitedTextDelimiter;
  maxCellBytes: number;
  maxColumns: number;
  maxRows: number;
}

const DELIMITER_DETECTION_MAX_RECORDS = 20;

export class DelimitedTextParseError extends Error {
  constructor() {
    super("Malformed delimited text.");
    this.name = "DelimitedTextParseError";
  }
}

function chooseDelimiter(
  counts: Record<DelimitedTextDelimiter, number>
): DelimitedTextDelimiter {
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) {
    return ";";
  }
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) {
    return "\t";
  }
  return ",";
}

function detectDelimiter(text: string): DelimitedTextDelimiter {
  const counts: Record<DelimitedTextDelimiter, number> = {
    ",": 0,
    ";": 0,
    "\t": 0,
  };
  let inspectedRecords = 0;
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (inQuotes) {
      continue;
    }
    if (char === "," || char === ";" || char === "\t") {
      counts[char] += 1;
      continue;
    }
    if (char !== "\n" && char !== "\r") {
      continue;
    }

    const delimiterCount = counts[","] + counts[";"] + counts["\t"];
    if (delimiterCount > 0) {
      return chooseDelimiter(counts);
    }
    inspectedRecords += 1;
    if (inspectedRecords >= DELIMITER_DETECTION_MAX_RECORDS) {
      return ",";
    }
    if (char === "\r" && text[index + 1] === "\n") {
      index += 1;
    }
  }

  return chooseDelimiter(counts);
}

function assertBound(value: number, name: string): void {
  if (!(Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

export function parseDelimitedText(
  text: string,
  options: ParseDelimitedTextOptions
): ParsedDelimitedText {
  assertBound(options.maxRows, "maxRows");
  assertBound(options.maxColumns, "maxColumns");
  assertBound(options.maxCellBytes, "maxCellBytes");

  const delimiter = options.delimiter ?? detectDelimiter(text);
  const trailingNewline = /(?:\r\n|\n|\r)$/.test(text);
  const rows: string[][] = [];
  let columnCount = 0;
  let currentCell = "";
  let currentCellBytes = 0;
  let currentCellHasData = false;
  let currentRow: string[] = [];
  let currentRowColumnCount = 0;
  let hasRecordData = false;
  let inQuotes = false;
  let closedQuote = false;
  let lineEnding: ParsedDelimitedText["lineEnding"] = "\n";
  let lineEndingDetected = false;
  let rowCount = 0;
  let truncated = false;

  const shouldCaptureCell = (): boolean =>
    rowCount < options.maxRows && currentRowColumnCount < options.maxColumns;

  const appendCellText = (value: string): void => {
    currentCellHasData = true;
    const valueBytes = Buffer.byteLength(value, "utf8");
    const nextCellBytes = currentCellBytes + valueBytes;
    if (nextCellBytes <= options.maxCellBytes && shouldCaptureCell()) {
      currentCell += value;
    } else if (nextCellBytes > options.maxCellBytes) {
      truncated = true;
    }
    currentCellBytes = nextCellBytes;
  };

  const pushCell = (): void => {
    if (shouldCaptureCell()) {
      currentRow.push(currentCell);
    } else if (currentRowColumnCount >= options.maxColumns) {
      truncated = true;
    }
    currentRowColumnCount += 1;
    currentCell = "";
    currentCellBytes = 0;
    currentCellHasData = false;
    closedQuote = false;
    hasRecordData = true;
  };

  const pushRow = (): void => {
    pushCell();
    rowCount += 1;
    columnCount = Math.max(columnCount, currentRowColumnCount);
    if (rowCount <= options.maxRows) {
      rows.push(currentRow);
    } else {
      truncated = true;
    }
    currentRow = [];
    currentRowColumnCount = 0;
    hasRecordData = false;
  };

  const recordLineEnding = (
    ending: ParsedDelimitedText["lineEnding"]
  ): void => {
    if (!lineEndingDetected) {
      lineEnding = ending;
      lineEndingDetected = true;
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          appendCellText('"');
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        const codePointWidth = (text.codePointAt(index) ?? 0) > 0xff_ff ? 2 : 1;
        appendCellText(text.slice(index, index + codePointWidth));
        index += codePointWidth - 1;
      }
      continue;
    }

    if (closedQuote && char !== delimiter && char !== "\n" && char !== "\r") {
      throw new DelimitedTextParseError();
    }
    if (char === '"') {
      if (currentCellHasData) {
        throw new DelimitedTextParseError();
      }
      inQuotes = true;
      hasRecordData = true;
    } else if (char === delimiter) {
      pushCell();
    } else if (char === "\n" || char === "\r") {
      const isCrLf = char === "\r" && text[index + 1] === "\n";
      recordLineEnding(isCrLf ? "\r\n" : char);
      pushRow();
      if (isCrLf) {
        index += 1;
      }
    } else {
      const codePointWidth = (text.codePointAt(index) ?? 0) > 0xff_ff ? 2 : 1;
      appendCellText(text.slice(index, index + codePointWidth));
      hasRecordData = true;
      index += codePointWidth - 1;
    }
  }

  if (inQuotes && !options.allowIncompleteFinalRecord) {
    throw new DelimitedTextParseError();
  }
  if (inQuotes) {
    truncated = true;
  }

  const hasPendingRecord =
    hasRecordData || currentRowColumnCount > 0 || inQuotes || closedQuote;
  if (hasPendingRecord && (!trailingNewline || inQuotes)) {
    pushRow();
  }

  return {
    columnCount,
    delimiter,
    lineEnding,
    rowCount,
    rows,
    trailingNewline,
    truncated,
  };
}
