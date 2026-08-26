import { describe, expect, test } from "bun:test";
import { DelimitedTextParseError, parseDelimitedText } from "./delimited-text";

describe("parseDelimitedText", () => {
  test("preserves CRLF, multiline quotes, escaped quotes, blank rows, and whitespace", () => {
    const parsed = parseDelimitedText(
      ' Name ;Notes\r\n" Alice ";"line 1\r\nline ""2"""\r\n\r\n',
      {
        maxCellBytes: 1024,
        maxColumns: 10,
        maxRows: 10,
      }
    );

    expect(parsed).toMatchObject({
      columnCount: 2,
      delimiter: ";",
      lineEnding: "\r\n",
      rowCount: 3,
      trailingNewline: true,
      truncated: false,
    });
    expect(parsed.rows).toEqual([
      [" Name ", "Notes"],
      [" Alice ", 'line 1\r\nline "2"'],
      [""],
    ]);
  });

  test("detects tabs after an intentional leading blank row", () => {
    const parsed = parseDelimitedText(
      '\r\nkey\t value \r\none\t"two\tinside"\r\n',
      {
        maxCellBytes: 1024,
        maxColumns: 10,
        maxRows: 10,
      }
    );

    expect(parsed.delimiter).toBe("\t");
    expect(parsed.rows).toEqual([
      [""],
      ["key", " value "],
      ["one", "two\tinside"],
    ]);
  });

  test("bounds retained rows, columns, and UTF-8 cell bytes while counting the source", () => {
    const parsed = parseDelimitedText("a,b,c\n1,toolong,3\n4,5,6\n", {
      maxCellBytes: 3,
      maxColumns: 2,
      maxRows: 2,
    });

    expect(parsed).toMatchObject({
      columnCount: 3,
      rowCount: 3,
      truncated: true,
    });
    expect(parsed.rows).toEqual([
      ["a", "b"],
      ["1", "too"],
    ]);
  });

  test("rejects invalid quote transitions and incomplete records", () => {
    expect(() =>
      parseDelimitedText('a,b\n"unterminated,b\n', {
        maxCellBytes: 1024,
        maxColumns: 10,
        maxRows: 10,
      })
    ).toThrow(DelimitedTextParseError);
    expect(() =>
      parseDelimitedText('a,b\n"closed"tail,b\n', {
        maxCellBytes: 1024,
        maxColumns: 10,
        maxRows: 10,
      })
    ).toThrow(DelimitedTextParseError);
  });
});
