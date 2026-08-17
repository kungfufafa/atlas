import { describe, expect, test } from "bun:test";
import { parseSetupAccountPrefill } from "./setup-wizard.shared";

describe("setup account prefill", () => {
  test("reads name, email, and phone without a password", () => {
    expect(
      parseSetupAccountPrefill(
        JSON.stringify({
          email: "admin@example.com",
          name: "Jane Admin",
          phone: "+628123456789",
        })
      )
    ).toEqual({
      email: "admin@example.com",
      name: "Jane Admin",
      phone: "+628123456789",
    });
  });

  test("ignores a stored payload that is missing required fields", () => {
    expect(
      parseSetupAccountPrefill(JSON.stringify({ email: "admin@example.com" }))
    ).toBeNull();
  });
});
