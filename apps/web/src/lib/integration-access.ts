export type IntegrationSectionId =
  | "telegram"
  | "whatsapp"
  | "discord"
  | "notifications"
  | "composio"
  | "token"
  | "coding-agents"
  | "optimization"
  | "error-tracking";

export function canAccessIntegrationSection(
  sectionId: IntegrationSectionId,
  access: { isOrgAdmin: boolean; isPlatformAdmin: boolean }
): boolean {
  if (access.isPlatformAdmin) {
    return true;
  }

  if (!access.isOrgAdmin) {
    return sectionId === "composio";
  }

  return !(
    sectionId === "token" ||
    sectionId === "coding-agents" ||
    sectionId === "error-tracking"
  );
}
