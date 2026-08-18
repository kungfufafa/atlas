import {
  Building03Icon,
  DashboardSquare01Icon,
  LayoutGridIcon,
  Plug01Icon,
} from "hugeicons-react";

export const SYSTEM_TABS = [
  { icon: DashboardSquare01Icon, id: "status" as const, label: "Status" },
  { icon: Building03Icon, id: "organization" as const, label: "Workspace" },
  { icon: LayoutGridIcon, id: "tools" as const, label: "Tools" },
  { icon: Plug01Icon, id: "mcp" as const, label: "MCP" },
] as const;

export type SystemTabId = (typeof SYSTEM_TABS)[number]["id"];

export function resolveSystemTab(value: string | null): SystemTabId {
  if (
    value === "status" ||
    value === "organization" ||
    value === "mcp" ||
    value === "tools"
  ) {
    return value;
  }

  return "tools";
}

export function visibleSystemTabs() {
  return SYSTEM_TABS;
}
