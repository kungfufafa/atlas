import { describe, expect, test } from "bun:test";
import {
  filterProfileScopedItems,
  resolveSelectedProfileId,
} from "./profile-selection";

const profiles = [
  { id: "first" },
  { id: "primary", isDefault: true },
  { id: "other" },
];

describe("profile selection", () => {
  test("keeps a preferred profile while it remains available", () => {
    expect(resolveSelectedProfileId(profiles, "other")).toBe("other");
  });

  test("falls back safely when the selected profile is removed", () => {
    expect(resolveSelectedProfileId(profiles, "removed")).toBe("primary");
    expect(
      resolveSelectedProfileId(
        profiles.filter((profile) => profile.id !== "primary"),
        "removed"
      )
    ).toBe("first");
  });

  test("recognizes the legacy default id and an empty profile list", () => {
    expect(resolveSelectedProfileId([{ id: "first" }, { id: "default" }])).toBe(
      "default"
    );
    expect(resolveSelectedProfileId([], "other")).toBeNull();
  });
});

describe("profile-scoped filtering", () => {
  const items = [
    { id: "one", profileId: "primary" },
    { id: "two", profileId: "other" },
    { id: "three", profileId: "primary" },
  ];

  test("returns only items belonging to the selected profile", () => {
    expect(filterProfileScopedItems(items, "primary")).toEqual([
      items[0],
      items[2],
    ]);
  });

  test("returns no workspace data when no profile is available", () => {
    expect(filterProfileScopedItems(items, null)).toEqual([]);
  });
});
