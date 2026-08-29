import { expect, test } from "bun:test";
import type { SessionSummary } from "@atlas/core/contract";
import {
  displaySessionPreview,
  displaySessionTitle,
  mergeSessionsByRecency,
} from "./sessions";

function session(
  id: string,
  profileId: string,
  updatedAt: string
): SessionSummary {
  return {
    channel: "web",
    createdAt: updatedAt,
    id,
    messageCount: 1,
    preview: null,
    profileId,
    title: id,
    updatedAt,
  };
}

test("merges sessions from every profile by recency", () => {
  const merged = mergeSessionsByRecency([
    [session("a", "p1", "2026-01-01T00:00:00.000Z")],
    [
      session("b", "p2", "2026-03-01T00:00:00.000Z"),
      session("c", "p2", "2026-02-01T00:00:00.000Z"),
    ],
  ]);

  expect(merged.map((item) => item.id)).toEqual(["b", "c", "a"]);
});

test("collapses markdown and long session copy for list rows", () => {
  expect(
    displaySessionTitle("Siap, berikut demo ```csv\nNo,Tanggal\n1,2026\n```")
  ).toBe("Siap, berikut demo");
  expect(displaySessionPreview("  hi\n\nthere  ")).toBe("hi there");
  expect(displaySessionTitle("   ")).toBe("Untitled chat");
});
