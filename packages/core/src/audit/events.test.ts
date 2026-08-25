import { describe, expect, test } from "bun:test";
import { PrincipalRequiredError } from "../identity/principal";
import { auditEventDigest, createAuditEvent } from "./events";

const principal = {
  isPlatformAdmin: false,
  orgId: "org_1",
  orgRole: "member" as const,
  userId: "user_1",
};

describe("audit trail", () => {
  test("redacts secrets before persist", () => {
    const event = createAuditEvent({
      action: "memory.write",
      id: "aud_1",
      payload: { text: "api_key=sk-abcdefghijklmnopqrstuvwxyz" },
      principal,
      resource: "memory:mem_1",
    });
    expect(JSON.stringify(event.payload)).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz"
    );
    expect(auditEventDigest(event).length).toBe(64);
  });

  test("fail closed without principal", () => {
    expect(() =>
      createAuditEvent({
        action: "tool.execute",
        id: "aud_1",
        payload: {},
        principal: { ...principal, userId: "" },
        resource: "tool:bash",
      })
    ).toThrow(PrincipalRequiredError);
  });
});
