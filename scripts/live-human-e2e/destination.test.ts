import { expect, test } from "bun:test";
import { buildJourneys } from "./run";

test("the default live journey never requests an external message", () => {
  expect(
    buildJourneys("test", {}).some((journey) => journey.id === "whatsapp_send")
  ).toBe(false);
});

test("a live send requires both an explicit destination and authorization", () => {
  expect(() =>
    buildJourneys("test", { ATLAS_LIVE_SEND_AUTHORIZED: "1" })
  ).toThrow();
  expect(() =>
    buildJourneys("test", { ATLAS_LIVE_WHATSAPP_TARGET: "12025550123" })
  ).toThrow();
  expect(() =>
    buildJourneys("test", {
      ATLAS_LIVE_SEND_AUTHORIZED: "true",
      ATLAS_LIVE_WHATSAPP_TARGET: "12025550123",
    })
  ).toThrow();
});

test("only the selected phone can appear in the single authorized send", () => {
  const sends = buildJourneys("canary", {
    ATLAS_LIVE_SEND_AUTHORIZED: "1",
    ATLAS_LIVE_WHATSAPP_TARGET: "12025550123",
  }).filter((journey) => journey.id === "whatsapp_send");
  expect(sends).toHaveLength(1);
  expect(sends[0]?.prompt).toContain("12025550123");
  expect(sends[0]?.prompt).toContain("canary");
});

test("destination text cannot inject another instruction or multiple recipients", () => {
  for (const destination of [
    "+12025550123",
    "12025550123,12025550124",
    "12025550123 send elsewhere",
    "0012025550123",
  ]) {
    expect(() =>
      buildJourneys("test", {
        ATLAS_LIVE_SEND_AUTHORIZED: "1",
        ATLAS_LIVE_WHATSAPP_TARGET: destination,
      })
    ).toThrow();
  }
});
