import { z } from "zod";
import type { ToolDefinition } from "../contract";
import {
  jsonSchemaFromZod,
  parseToolInput,
  requiredTrimmedString,
} from "./schema";

export const calculatorInputSchema = z
  .object({
    expression: requiredTrimmedString("expression"),
  })
  .strict();

export type CalculatorInput = z.infer<typeof calculatorInputSchema>;

export interface CalculatorOutput {
  expression: string;
  formatted: string;
  result: number;
}

type TokenType =
  | "NUMBER"
  | "IDENTIFIER"
  | "PLUS"
  | "MINUS"
  | "MULTIPLY"
  | "DIVIDE"
  | "MODULO"
  | "PERCENT"
  | "POWER"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "EOF";

interface Token {
  pos: number;
  type: TokenType;
  value?: string | number;
}

const MATH_CONSTANTS: Record<string, number> = {
  E: Math.E,
  e: Math.E,
  PI: Math.PI,
  pi: Math.PI,
  TAU: Math.PI * 2,
  tau: Math.PI * 2,
};

const MATH_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  acos: (x) => {
    if (x < -1 || x > 1) {
      throw new Error(
        `Math error: acos argument must be between -1 and 1 (got ${x})`
      );
    }
    return Math.acos(x);
  },
  asin: (x) => {
    if (x < -1 || x > 1) {
      throw new Error(
        `Math error: asin argument must be between -1 and 1 (got ${x})`
      );
    }
    return Math.asin(x);
  },
  atan: Math.atan,
  cbrt: Math.cbrt,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  ln: (x) => {
    if (x <= 0) {
      throw new Error(`Math error: ln argument must be positive (got ${x})`);
    }
    return Math.log(x);
  },
  log: (x) => {
    if (x <= 0) {
      throw new Error(`Math error: log argument must be positive (got ${x})`);
    }
    return Math.log(x);
  },
  log2: (x) => {
    if (x <= 0) {
      throw new Error(`Math error: log2 argument must be positive (got ${x})`);
    }
    return Math.log2(x);
  },
  log10: (x) => {
    if (x <= 0) {
      throw new Error(`Math error: log10 argument must be positive (got ${x})`);
    }
    return Math.log10(x);
  },
  max: (...args) => {
    if (args.length === 0) {
      throw new Error("Math error: max() requires at least 1 argument");
    }
    return Math.max(...args);
  },
  min: (...args) => {
    if (args.length === 0) {
      throw new Error("Math error: min() requires at least 1 argument");
    }
    return Math.min(...args);
  },
  pow: (x, y) => x ** y,
  round: Math.round,
  sin: Math.sin,
  sqrt: (x) => {
    if (x < 0) {
      throw new Error(
        `Math error: sqrt of negative number (${x}) is undefined in real numbers`
      );
    }
    return Math.sqrt(x);
  },
  tan: Math.tan,
  trunc: Math.trunc,
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i]!;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === "+") {
      tokens.push({ pos: i, type: "PLUS" });
      i += 1;
      continue;
    }

    if (char === "-") {
      tokens.push({ pos: i, type: "MINUS" });
      i += 1;
      continue;
    }

    if (char === "*") {
      if (input[i + 1] === "*") {
        tokens.push({ pos: i, type: "POWER" });
        i += 2;
      } else {
        tokens.push({ pos: i, type: "MULTIPLY" });
        i += 1;
      }
      continue;
    }

    if (char === "/") {
      tokens.push({ pos: i, type: "DIVIDE" });
      i += 1;
      continue;
    }

    if (char === "%") {
      tokens.push({ pos: i, type: "PERCENT" });
      i += 1;
      continue;
    }

    if (char === "^") {
      tokens.push({ pos: i, type: "POWER" });
      i += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ pos: i, type: "LPAREN" });
      i += 1;
      continue;
    }

    if (char === ")") {
      tokens.push({ pos: i, type: "RPAREN" });
      i += 1;
      continue;
    }

    if (char === ",") {
      tokens.push({ pos: i, type: "COMMA" });
      i += 1;
      continue;
    }

    // Numbers: integer, floating point, scientific notation (e.g. 1.5e-3)
    if (
      /[0-9]/.test(char) ||
      (char === "." && /[0-9]/.test(input[i + 1] ?? ""))
    ) {
      let numStr = "";
      const startPos = i;
      while (i < input.length && /[0-9]/.test(input[i]!)) {
        numStr += input[i];
        i += 1;
      }
      if (i < input.length && input[i] === ".") {
        numStr += ".";
        i += 1;
        while (i < input.length && /[0-9]/.test(input[i]!)) {
          numStr += input[i];
          i += 1;
        }
      }
      if (i < input.length && (input[i] === "e" || input[i] === "E")) {
        const nextChar = input[i + 1];
        if (
          nextChar &&
          (/[0-9]/.test(nextChar) || nextChar === "+" || nextChar === "-")
        ) {
          numStr += input[i];
          i += 1;
          if (input[i] === "+" || input[i] === "-") {
            numStr += input[i];
            i += 1;
          }
          while (i < input.length && /[0-9]/.test(input[i]!)) {
            numStr += input[i];
            i += 1;
          }
        }
      }
      const numVal = Number(numStr);
      if (Number.isNaN(numVal)) {
        throw new Error(`Invalid number '${numStr}' at position ${startPos}`);
      }
      tokens.push({ pos: startPos, type: "NUMBER", value: numVal });
      continue;
    }

    // Identifiers: functions or constants
    if (/[a-zA-Z_]/.test(char)) {
      let name = "";
      const startPos = i;
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i]!)) {
        name += input[i];
        i += 1;
      }
      tokens.push({ pos: startPos, type: "IDENTIFIER", value: name });
      continue;
    }

    throw new Error(`Unexpected character '${char}' at position ${i}`);
  }

  tokens.push({ pos: input.length, type: "EOF" });
  return tokens;
}

function isExpressionStart(tokenType: TokenType): boolean {
  return (
    tokenType === "NUMBER" ||
    tokenType === "IDENTIFIER" ||
    tokenType === "LPAREN" ||
    tokenType === "PLUS" ||
    tokenType === "MINUS"
  );
}

class Parser {
  private current = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.current] ?? { pos: -1, type: "EOF" };
  }

  private peekNext(): Token {
    return this.tokens[this.current + 1] ?? { pos: -1, type: "EOF" };
  }

  private advance(): Token {
    const token = this.peek();
    if (token.type !== "EOF") {
      this.current += 1;
    }
    return token;
  }

  private match(...types: TokenType[]): Token | null {
    const token = this.peek();
    if (types.includes(token.type)) {
      return this.advance();
    }
    return null;
  }

  private expect(type: TokenType, message?: string): Token {
    const token = this.peek();
    if (token.type === type) {
      return this.advance();
    }
    throw new Error(
      message ??
        `Expected token type '${type}' but got '${token.type}' at position ${token.pos}`
    );
  }

  parse(): number {
    if (this.peek().type === "EOF") {
      throw new Error("Expression is empty.");
    }
    const result = this.expression();
    if (this.peek().type !== "EOF") {
      const extra = this.peek();
      throw new Error(
        `Unexpected token '${extra.value ?? extra.type}' after valid expression at position ${extra.pos}`
      );
    }
    if (!Number.isFinite(result)) {
      throw new Error(
        "Calculation resulted in non-finite value (Infinity or NaN)."
      );
    }
    return result;
  }

  private expression(): number {
    return this.additive();
  }

  private additive(): number {
    let left = this.multiplicative();

    while (true) {
      const op = this.match("PLUS", "MINUS");
      if (!op) {
        break;
      }
      const right = this.multiplicative();
      if (op.type === "PLUS") {
        left += right;
      } else {
        left -= right;
      }
    }

    return left;
  }

  private multiplicative(): number {
    let left = this.exponent();

    while (true) {
      const next = this.peek();
      if (next.type === "MULTIPLY" || next.type === "DIVIDE") {
        const op = this.advance();
        const right = this.exponent();
        if (op.type === "MULTIPLY") {
          left *= right;
        } else {
          if (right === 0) {
            throw new Error("Math error: Division by zero");
          }
          left /= right;
        }
      } else if (
        next.type === "PERCENT" &&
        isExpressionStart(this.peekNext().type)
      ) {
        // Binary modulo operator e.g. "17 % 5"
        this.advance(); // consume PERCENT as modulo
        const right = this.exponent();
        if (right === 0) {
          throw new Error("Math error: Modulo by zero");
        }
        left %= right;
      } else {
        break;
      }
    }

    return left;
  }

  private exponent(): number {
    let base = this.postfix();

    if (this.match("POWER")) {
      const power = this.exponent(); // right-associative
      base **= power;
    }

    return base;
  }

  private postfix(): number {
    let value = this.unary();

    while (
      this.peek().type === "PERCENT" &&
      !isExpressionStart(this.peekNext().type)
    ) {
      this.advance();
      value /= 100;
    }

    return value;
  }

  private unary(): number {
    if (this.match("PLUS")) {
      return this.unary();
    }
    if (this.match("MINUS")) {
      return -this.unary();
    }
    return this.primary();
  }

  private primary(): number {
    const token = this.peek();

    if (token.type === "NUMBER") {
      this.advance();
      return token.value as number;
    }

    if (token.type === "IDENTIFIER") {
      const id = token.value as string;
      this.advance();

      // Check if function call
      if (this.peek().type === "LPAREN") {
        this.advance(); // consume LPAREN
        const args: number[] = [];
        if (this.peek().type !== "RPAREN") {
          args.push(this.expression());
          while (this.match("COMMA")) {
            args.push(this.expression());
          }
        }
        this.expect(
          "RPAREN",
          `Expected ')' after function arguments for '${id}'`
        );

        const fn = MATH_FUNCTIONS[id.toLowerCase()];
        if (!fn) {
          throw new Error(`Unknown function '${id}' at position ${token.pos}`);
        }
        return fn(...args);
      }

      // Constant
      const constant = MATH_CONSTANTS[id];
      if (constant !== undefined) {
        return constant;
      }

      const lowerConstant = MATH_CONSTANTS[id.toLowerCase()];
      if (lowerConstant !== undefined) {
        return lowerConstant;
      }

      throw new Error(`Unknown identifier '${id}' at position ${token.pos}`);
    }

    if (token.type === "LPAREN") {
      this.advance();
      const expr = this.expression();
      this.expect(
        "RPAREN",
        `Expected ')' to close parenthesis starting at position ${token.pos}`
      );
      return expr;
    }

    throw new Error(
      `Unexpected token '${token.value ?? token.type}' at position ${token.pos}`
    );
  }
}

export function evaluateMathExpression(expression: string): number {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Expression cannot be empty.");
  }
  if (trimmed.length > 2000) {
    throw new Error(
      "Expression exceeds maximum allowed length of 2000 characters."
    );
  }
  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens);
  return parser.parse();
}

export function formatMathResult(value: number): string {
  if (Number.isInteger(value)) {
    return value.toString();
  }
  // Trim excessive floating-point precision artifacts e.g. 0.1 + 0.2 -> 0.3
  const rounded = Number(value.toPrecision(14));
  return rounded.toString();
}

export async function runCalculator(
  input: unknown,
  _context?: unknown
): Promise<CalculatorOutput> {
  const parsed = parseToolInput(calculatorInputSchema, input);
  const result = evaluateMathExpression(parsed.expression);
  const formatted = formatMathResult(result);

  return {
    expression: parsed.expression,
    formatted,
    result,
  };
}

export const calculatorTool: ToolDefinition<CalculatorInput, CalculatorOutput> =
  {
    description:
      "Calculate a mathematical expression deterministically and safely. Supports basic arithmetic (+, -, *, /, %, ^ or **), parentheses, percentages (e.g. 17.5%), math functions (sqrt, sin, cos, tan, abs, round, ceil, floor, log, log10, exp, pow, min, max), and constants (pi, e).",
    name: "calculator",
    parallelSafe: true,
    parameters: jsonSchemaFromZod(calculatorInputSchema),
    run(input, context) {
      return runCalculator(input, context);
    },
  };
