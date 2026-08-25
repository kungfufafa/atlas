import { describe, expect, test } from "bun:test";
import { LOCAL_CLIENT_USER_ID } from "../local-auth";
import {
  assertCanonicalPrincipal,
  assertExternalPrincipal,
  isServiceAccountUserId,
  PrincipalRequiredError,
  resolveCanonicalPrincipal,
} from "./principal";

describe("canonical principal", () => {
  test("rejects missing channel user id", () => {
    expect(() =>
      assertExternalPrincipal({
        channel: "telegram",
        channelUserId: " ",
        orgId: "org_1",
      })
    ).toThrow(PrincipalRequiredError);
  });

  test("rejects service-account user as canonical principal", () => {
    expect(isServiceAccountUserId(LOCAL_CLIENT_USER_ID)).toBe(true);
    expect(() =>
      assertCanonicalPrincipal({
        orgId: "org_1",
        orgRole: "admin",
        userId: LOCAL_CLIENT_USER_ID,
      })
    ).toThrow(/service-account/);
  });

  test("fail closed when mapping is missing", () => {
    expect(() =>
      resolveCanonicalPrincipal({
        mapping: null,
        member: { orgRole: "member" },
        principal: {
          channel: "telegram",
          channelUserId: "42",
          orgId: "org_1",
        },
      })
    ).toThrow(/No canonical user mapping/);
  });

  test("fail closed when mapping org mismatches", () => {
    expect(() =>
      resolveCanonicalPrincipal({
        mapping: { orgId: "org_other", userId: "user_1" },
        member: { orgRole: "member" },
        principal: {
          channel: "telegram",
          channelUserId: "42",
          orgId: "org_1",
        },
      })
    ).toThrow(/org does not match/);
  });

  test("fail closed when mapped user is not an org member", () => {
    expect(() =>
      resolveCanonicalPrincipal({
        mapping: { orgId: "org_1", userId: "user_1" },
        member: null,
        principal: {
          channel: "telegram",
          channelUserId: "42",
          orgId: "org_1",
        },
      })
    ).toThrow(/not a member/);
  });

  test("resolves telegram external principal to atlas user", () => {
    const principal = resolveCanonicalPrincipal({
      mapping: { orgId: "org_1", userId: "user_1" },
      member: { isPlatformAdmin: false, orgRole: "member" },
      principal: {
        channel: "telegram",
        channelUserId: "42",
        orgId: "org_1",
      },
    });

    expect(principal).toEqual({
      isPlatformAdmin: false,
      orgId: "org_1",
      orgRole: "member",
      userId: "user_1",
    });
  });
});
