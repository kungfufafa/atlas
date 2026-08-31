import { describe, expect, test } from "bun:test";
import { normalizeStyledLine, styledLine, styledLineText } from "./styled-text";
import { printLine, TerminalTextStreamSanitizer } from "./terminal-safe";

describe("CLI ANSI sanitization", () => {
  test("normalizes plain and styled strings without escape sequences", () => {
    const plain = normalizeStyledLine("hi\x1b[31mRED\x1b[0m\x1b[2J");
    const styled = styledLine("evil\x1b[2Jname", { dim: true });

    expect(styledLineText(plain)).toBe("hiRED");
    expect(styledLineText(styled)).toBe("evilname");
  });

  test("printLine strips ANSI before logging", () => {
    const original = console.log;
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      printLine("ok\x1b[2J");
      expect(calls).toEqual([["ok"]]);
    } finally {
      console.log = original;
    }
  });

  test("stream sanitizer strips CSI and OSC sequences split across chunks", () => {
    const sanitizer = new TerminalTextStreamSanitizer();

    expect(sanitizer.push("safe\x1b[")).toBe("safe");
    expect(sanitizer.push("2Jafter\x1b]0;owned")).toBe("after");
    expect(sanitizer.push(" title\x1b")).toBe("");
    expect(sanitizer.push("\\done")).toBe("done");
  });

  test("stream sanitizer removes C0 and C1 controls but keeps line breaks", () => {
    const sanitizer = new TerminalTextStreamSanitizer();

    expect(sanitizer.push("a\u0000b\u009bc\n\u0007d")).toBe("ab\nd");
  });
});
