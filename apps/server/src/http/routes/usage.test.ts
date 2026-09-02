import { describe, expect, test } from "bun:test";
import { AtlasApiError } from "@atlas/core";
import { csvField, parseUsageReportQuery } from "./usage";

describe("usage report query parsing", () => {
  test("accepts attributable and historical unknown channels", () => {
    expect(
      parseUsageReportQuery({
        channel: "unknown",
        from: "2026-08-01",
        groupBy: "user",
        limit: "25",
        to: "2026-08-31",
      })
    ).toEqual({
      channel: "unknown",
      from: "2026-08-01",
      groupBy: "user",
      limit: 25,
      to: "2026-08-31",
    });
  });

  test.each([
    [{ channel: "whatsap" }, "channel"],
    [{ groupBy: "users" }, "groupBy"],
    [{ from: "2026-02-30" }, "from"],
    [{ to: "31-08-2026" }, "to"],
    [{ limit: "0" }, "limit"],
    [{ from: "2026-09-01", to: "2026-08-31" }, "on or before"],
  ])("rejects an invalid or unsafe query %#", (input, message) => {
    expect(() => parseUsageReportQuery(input)).toThrow(AtlasApiError);
    expect(() => parseUsageReportQuery(input)).toThrow(message);
  });
});

describe("usage CSV fields", () => {
  test.each(["=1+1", "+cmd", "-2+3", "@SUM(A1)", "  =1+1", "\t=1+1"])(
    "neutralizes spreadsheet formula input %s",
    (value) => {
      expect(csvField(value).startsWith("'")).toBe(true);
    }
  );

  test("keeps numeric metrics numeric and still applies RFC CSV quoting", () => {
    expect(csvField(-1)).toBe("-1");
    expect(csvField('Alice, "Ops"')).toBe('"Alice, ""Ops"""');
  });
});
