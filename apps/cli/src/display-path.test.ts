import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatCliDisplayPath, isCliVerbose } from "./display-path";

describe("isCliVerbose", () => {
  test("detects --verbose", () => {
    expect(isCliVerbose(["--org", "acme", "--verbose"])).toBe(true);
    expect(isCliVerbose(["--profile", "default"])).toBe(false);
  });
});

describe("formatCliDisplayPath", () => {
  const home = homedir();
  const soulDir = join(
    home,
    ".atlas",
    "orgs",
    "org_052abc599f8446afb7fde999214c776c",
    "profiles",
    "linus-torvalds"
  );
  const configPath = join(home, ".atlas", "config.ini");

  test("masks home, org id, and profile id by default", () => {
    expect(formatCliDisplayPath(soulDir)).toBe(
      "~/.atlas/orgs/<org>/profiles/<profile>"
    );
  });

  test("masks config home without inventing tenant segments", () => {
    expect(formatCliDisplayPath(configPath)).toBe("~/.atlas/config.ini");
  });

  test("returns absolute paths in verbose mode", () => {
    expect(formatCliDisplayPath(soulDir, true)).toBe(soulDir);
    expect(formatCliDisplayPath(configPath, true)).toBe(configPath);
  });

  test("masks foreign home prefixes", () => {
    expect(
      formatCliDisplayPath("/Users/other/.atlas/orgs/org_abc/profiles/bot")
    ).toBe("~/.atlas/orgs/<org>/profiles/<profile>");
  });
});
