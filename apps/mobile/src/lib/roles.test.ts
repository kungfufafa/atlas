import { expect, test } from "bun:test";
import {
  canAccessFilesPage,
  canAccessIntegrationsPage,
  canMutateWorkspace,
  isWorkspaceAdmin,
} from "./roles";

test("workspace admins include org admins and platform admins", () => {
  expect(
    isWorkspaceAdmin({
      activeOrg: { role: "admin" } as never,
      isPlatformAdmin: false,
    })
  ).toBe(true);
  expect(
    isWorkspaceAdmin({
      activeOrg: { role: "member" } as never,
      isPlatformAdmin: true,
    })
  ).toBe(true);
  expect(
    isWorkspaceAdmin({
      activeOrg: { role: "member" } as never,
      isPlatformAdmin: false,
    })
  ).toBe(false);
});

test("only admins and members can mutate the workspace", () => {
  expect(
    canMutateWorkspace({
      activeOrg: { role: "viewer" } as never,
    })
  ).toBe(false);
  expect(
    canMutateWorkspace({
      activeOrg: { role: "member" } as never,
    })
  ).toBe(true);
  expect(
    canMutateWorkspace({
      activeOrg: null,
      isPlatformAdmin: true,
    })
  ).toBe(false);
});

test("files stay workspace-admin only", () => {
  expect(
    canAccessFilesPage({
      activeOrg: { role: "member" } as never,
      isPlatformAdmin: false,
    })
  ).toBe(false);
  expect(
    canAccessFilesPage({
      activeOrg: { role: "admin" } as never,
    })
  ).toBe(true);
});

test("integrations are closed to viewers", () => {
  expect(
    canAccessIntegrationsPage({
      activeOrg: { role: "viewer" } as never,
    })
  ).toBe(false);
  expect(
    canAccessIntegrationsPage({
      activeOrg: { role: "member" } as never,
    })
  ).toBe(true);
});
