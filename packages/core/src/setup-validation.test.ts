import { describe, expect, test } from "bun:test";
import {
  slugifySetupWorkspaceName,
  validateSetupEmail,
  validateSetupPassword,
  validateSetupPhone,
  validateSetupWorkspaceSlug,
} from "./setup-validation";

describe("setup validation", () => {
  test("accepts a normal email and rejects an incomplete one", () => {
    expect(validateSetupEmail("Admin@Example.com")).toBeNull();
    expect(validateSetupEmail("admin@example")).toBe(
      "A valid email address is required."
    );
    expect(validateSetupEmail("")).toBe("A valid email address is required.");
  });

  test("allows an empty phone and rejects symbols that are not a number", () => {
    expect(validateSetupPhone("")).toBeNull();
    expect(validateSetupPhone("   ")).toBeNull();
    expect(validateSetupPhone("+628123456789")).toBeNull();
    expect(validateSetupPhone("not-a-phone")).toBe(
      "Enter a valid phone number."
    );
  });

  test("requires a matching password of at least 8 characters", () => {
    expect(validateSetupPassword("short")).toBe(
      "Password must be at least 8 characters."
    );
    expect(validateSetupPassword("password123", "password124")).toBe(
      "Passwords do not match."
    );
    expect(validateSetupPassword("password123", "password123")).toBeNull();
  });

  test("slugifies a workspace name and validates the result", () => {
    expect(slugifySetupWorkspaceName("Acme Corp")).toBe("acme-corp");
    expect(slugifySetupWorkspaceName("@@@")).toBe("personal");
    expect(validateSetupWorkspaceSlug("acme-corp")).toBeNull();
    expect(validateSetupWorkspaceSlug("acme_corp")).toBe(
      "Slug must use lowercase letters, numbers, and hyphens."
    );
  });
});
