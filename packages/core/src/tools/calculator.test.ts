import { describe, expect, test } from "bun:test";
import {
  calculatorTool,
  evaluateMathExpression,
  runCalculator,
} from "./calculator";

describe("calculator tool", () => {
  test("evaluates basic arithmetic", () => {
    expect(evaluateMathExpression("2 + 2")).toBe(4);
    expect(evaluateMathExpression("10 - 3")).toBe(7);
    expect(evaluateMathExpression("6 * 7")).toBe(42);
    expect(evaluateMathExpression("15 / 3")).toBe(5);
    expect(evaluateMathExpression("17 % 5")).toBe(2);
    expect(evaluateMathExpression("2 ^ 8")).toBe(256);
    expect(evaluateMathExpression("2 ** 8")).toBe(256);
  });

  test("handles operator precedence and parentheses", () => {
    expect(evaluateMathExpression("2 + 3 * 4")).toBe(14);
    expect(evaluateMathExpression("(2 + 3) * 4")).toBe(20);
    expect(evaluateMathExpression("(12500 * 17.5) / 7")).toBe(31_250);
    expect(evaluateMathExpression("100 - (20 + 30) / 2")).toBe(75);
    expect(evaluateMathExpression("2 ^ 3 ^ 2")).toBe(512);
  });

  test("handles percentages", () => {
    expect(evaluateMathExpression("50%")).toBe(0.5);
    expect(evaluateMathExpression("12500 * 17.5%")).toBe(2187.5);
    expect(evaluateMathExpression("200 + 200 * 10%")).toBe(220);
    expect(evaluateMathExpression("100%%")).toBe(0.01);
  });

  test("handles unary plus and minus", () => {
    expect(evaluateMathExpression("-5 + 10")).toBe(5);
    expect(evaluateMathExpression("+5 + -3")).toBe(2);
    expect(evaluateMathExpression("-(-5)")).toBe(5);
  });

  test("evaluates mathematical constants", () => {
    expect(evaluateMathExpression("pi")).toBe(Math.PI);
    expect(evaluateMathExpression("PI")).toBe(Math.PI);
    expect(evaluateMathExpression("e")).toBe(Math.E);
    expect(evaluateMathExpression("2 * pi * 10")).toBeCloseTo(2 * Math.PI * 10);
  });

  test("evaluates mathematical functions", () => {
    expect(evaluateMathExpression("sqrt(144)")).toBe(12);
    expect(evaluateMathExpression("cbrt(27)")).toBe(3);
    expect(evaluateMathExpression("abs(-42)")).toBe(42);
    expect(evaluateMathExpression("round(4.6)")).toBe(5);
    expect(evaluateMathExpression("floor(4.9)")).toBe(4);
    expect(evaluateMathExpression("ceil(4.1)")).toBe(5);
    expect(evaluateMathExpression("min(10, 5, 20, 2)")).toBe(2);
    expect(evaluateMathExpression("max(10, 5, 20, 2)")).toBe(20);
    expect(evaluateMathExpression("pow(2, 5)")).toBe(32);
    expect(evaluateMathExpression("log10(1000)")).toBe(3);
    expect(evaluateMathExpression("log2(16)")).toBe(4);
    expect(evaluateMathExpression("sin(0)")).toBe(0);
    expect(evaluateMathExpression("cos(0)")).toBe(1);
  });

  test("handles errors cleanly and safely", () => {
    expect(() => evaluateMathExpression("10 / 0")).toThrow("Division by zero");
    expect(() => evaluateMathExpression("10 % 0")).toThrow("Modulo by zero");
    expect(() => evaluateMathExpression("sqrt(-4)")).toThrow("negative number");
    expect(() => evaluateMathExpression("log(-1)")).toThrow("positive");
    expect(() => evaluateMathExpression("(2 + 3")).toThrow("Expected ')'");
    expect(() => evaluateMathExpression("foo(5)")).toThrow("Unknown function");
    expect(() => evaluateMathExpression("eval('alert(1)')")).toThrow();
    expect(() => evaluateMathExpression("")).toThrow("cannot be empty");
  });

  test("runCalculator returns formatted output", async () => {
    const output = await runCalculator({ expression: "(12500 * 17.5) / 7" });
    expect(output.result).toBe(31_250);
    expect(output.formatted).toBe("31250");
    expect(output.expression).toBe("(12500 * 17.5) / 7");
  });

  test("calculatorTool definition matches interface", () => {
    expect(calculatorTool.name).toBe("calculator");
    expect(calculatorTool.parallelSafe).toBe(true);
    expect(calculatorTool.parameters).toBeDefined();
  });
});
