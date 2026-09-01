import { expect, test } from "bun:test";
import {
  inviteAcceptPath,
  inviteAcceptUrl,
  tokenFromInviteInput,
} from "./invite";

test("builds a portable invite path and server URL", () => {
  expect(inviteAcceptPath("token with spaces")).toBe(
    "/invite?token=token+with+spaces"
  );
  expect(inviteAcceptUrl("https://atlas.example/", "abc")).toBe(
    "https://atlas.example/invite?token=abc"
  );
});

test("keeps a bare invite token", () => {
  expect(tokenFromInviteInput(" abc123 ")).toBe("abc123");
});

test("pulls the token from a web or atlas invite URL", () => {
  expect(
    tokenFromInviteInput("https://atlas.example.com/invite?token=inv_9")
  ).toBe("inv_9");
  expect(tokenFromInviteInput("atlas://invite?token=inv_9")).toBe("inv_9");
});
