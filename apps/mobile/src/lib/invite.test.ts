import { expect, test } from "bun:test";
import { tokenFromInviteInput } from "./invite";

test("keeps a bare invite token", () => {
  expect(tokenFromInviteInput(" abc123 ")).toBe("abc123");
});

test("pulls the token from a web or atlas invite URL", () => {
  expect(
    tokenFromInviteInput("https://atlas.example.com/invite?token=inv_9")
  ).toBe("inv_9");
  expect(tokenFromInviteInput("atlas://invite?token=inv_9")).toBe("inv_9");
});
