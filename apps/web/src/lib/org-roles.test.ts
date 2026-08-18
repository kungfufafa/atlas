import { describe, expect, it } from "bun:test";
import {
  canCompleteWorkspaceSetup,
  canMutateWorkspace,
  isViewerRole,
} from "./org-roles";

describe("org role helpers", () => {
  it("treats viewers as read-only", () => {
    expect(isViewerRole("viewer")).toBe(true);
    expect(isViewerRole("member")).toBe(false);
    expect(canMutateWorkspace("viewer")).toBe(false);
    expect(canMutateWorkspace("member")).toBe(true);
    expect(canMutateWorkspace("admin")).toBe(true);
  });

  it("limits setup completion to Superadmins and Workspace Admins", () => {
    expect(canCompleteWorkspaceSetup(true, "viewer")).toBe(true);
    expect(canCompleteWorkspaceSetup(false, "admin")).toBe(true);
    expect(canCompleteWorkspaceSetup(false, "member")).toBe(false);
    expect(canCompleteWorkspaceSetup(false, "viewer")).toBe(false);
  });
});
