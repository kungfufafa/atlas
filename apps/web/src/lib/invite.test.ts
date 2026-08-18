import { describe, expect, it } from "bun:test";
import {
  inviteAcceptPath,
  inviteAcceptUrl,
  tokenFromInviteInput,
} from "./invite";

describe("invite helpers", () => {
  it("builds an accept path and absolute URL", () => {
    expect(inviteAcceptPath("abc")).toBe("/invite?token=abc");
    expect(inviteAcceptUrl("https://atlas.example", "abc")).toBe(
      "https://atlas.example/invite?token=abc"
    );
    expect(inviteAcceptUrl("https://atlas.example/", "abc")).toBe(
      "https://atlas.example/invite?token=abc"
    );
  });

  it("reads a token from pasted URLs or raw values", () => {
    expect(tokenFromInviteInput(" raw-token ")).toBe("raw-token");
    expect(
      tokenFromInviteInput("https://atlas.example/invite?token=from-url")
    ).toBe("from-url");
    expect(tokenFromInviteInput("https://atlas.example/invite")).toBe(
      "https://atlas.example/invite"
    );
  });
});
