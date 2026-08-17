import { describe, expect, test } from "bun:test";
import { buildCliSetupRequest } from "./setup";

describe("buildCliSetupRequest", () => {
  test("builds the setup payload with a default workspace", () => {
    expect(
      buildCliSetupRequest({
        confirmPassword: "password123",
        email: "Admin@Example.com",
        name: "Jane Admin",
        password: "password123",
        workspaceName: "",
      })
    ).toEqual({
      request: {
        admin: {
          email: "Admin@Example.com",
          name: "Jane Admin",
          password: "password123",
        },
        organization: {
          name: "Personal",
          slug: "personal",
        },
      },
    });
  });

  test("rejects mismatched passwords before calling the API", () => {
    expect(
      buildCliSetupRequest({
        confirmPassword: "password124",
        email: "admin@example.com",
        name: "Jane Admin",
        password: "password123",
        workspaceName: "Acme",
      })
    ).toEqual({ error: "Passwords do not match." });
  });
});
