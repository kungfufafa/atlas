import { stripAnsi } from "./text-measure";

type StreamState =
  | "csi"
  | "escape"
  | "escape-intermediate"
  | "string"
  | "string-escape"
  | "text";

const ESCAPE = 0x1b;
const DELETE = 0x7f;
const C1_START = 0x80;
const C1_END = 0x9f;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;

function isAllowedTextControl(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
}

function isStringControl(codePoint: number): boolean {
  return (
    codePoint === C1_DCS ||
    codePoint === C1_SOS ||
    codePoint === C1_OSC ||
    codePoint === C1_PM ||
    codePoint === C1_APC
  );
}

/** Strip terminal controls even when an escape sequence spans stream chunks. */
export class TerminalTextStreamSanitizer {
  private state: StreamState = "text";

  push(input: string): string {
    let output = "";

    for (const character of input) {
      const codePoint = character.codePointAt(0) ?? 0;

      if (this.state === "csi") {
        if (codePoint >= 0x40 && codePoint <= 0x7e) {
          this.state = "text";
        }
        continue;
      }

      if (this.state === "string") {
        if (codePoint === 0x07 || codePoint === C1_ST) {
          this.state = "text";
        } else if (codePoint === ESCAPE) {
          this.state = "string-escape";
        }
        continue;
      }

      if (this.state === "string-escape") {
        if (character === "\\" || codePoint === C1_ST) {
          this.state = "text";
        } else if (codePoint !== ESCAPE) {
          this.state = "string";
        }
        continue;
      }

      if (this.state === "escape-intermediate") {
        if (codePoint >= 0x30 && codePoint <= 0x7e) {
          this.state = "text";
        }
        continue;
      }

      if (this.state === "escape") {
        if (character === "[") {
          this.state = "csi";
        } else if ("]PX^_".includes(character)) {
          this.state = "string";
        } else if (codePoint >= 0x20 && codePoint <= 0x2f) {
          this.state = "escape-intermediate";
        } else if (codePoint !== ESCAPE) {
          this.state = "text";
        }
        continue;
      }

      if (codePoint === ESCAPE) {
        this.state = "escape";
      } else if (codePoint === C1_CSI) {
        this.state = "csi";
      } else if (isStringControl(codePoint)) {
        this.state = "string";
      } else if (
        !(
          (codePoint < 0x20 && !isAllowedTextControl(codePoint)) ||
          codePoint === DELETE ||
          (codePoint >= C1_START && codePoint <= C1_END)
        )
      ) {
        output += character;
      }
    }

    return output;
  }
}

/** Print one terminal line after stripping untrusted ANSI/control sequences. */
export function printLine(line: string): void {
  console.log(stripAnsi(line));
}
