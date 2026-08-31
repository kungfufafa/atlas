import { describe, expect, test } from "bun:test";
import {
  canAccessIntegrationSection,
  type IntegrationSectionId,
} from "./integration-access";

const sections: IntegrationSectionId[] = [
  "telegram",
  "whatsapp",
  "discord",
  "notifications",
  "composio",
  "token",
  "coding-agents",
  "optimization",
  "error-tracking",
];

function visibleSections(access: {
  isOrgAdmin: boolean;
  isPlatformAdmin: boolean;
}): IntegrationSectionId[] {
  return sections.filter((sectionId) =>
    canAccessIntegrationSection(sectionId, access)
  );
}

describe("integration settings access", () => {
  test("reserves host-global settings for platform admins", () => {
    expect(
      visibleSections({ isOrgAdmin: true, isPlatformAdmin: false })
    ).not.toContain("error-tracking");
    expect(
      visibleSections({ isOrgAdmin: false, isPlatformAdmin: true })
    ).toContain("error-tracking");
  });

  test("keeps ordinary members on personal Composio connections", () => {
    expect(
      visibleSections({ isOrgAdmin: false, isPlatformAdmin: false })
    ).toEqual(["composio"]);
  });
});
