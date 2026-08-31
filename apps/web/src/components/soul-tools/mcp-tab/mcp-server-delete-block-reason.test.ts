import { describe, expect, test } from "bun:test";
import type { McpServerSummary } from "@atlas/core/contract";
import { PREINSTALLED_MCP_SERVER_IDS } from "@atlas/core/mcp/preinstalled";
import { mcpServerDeleteBlockReason } from "./mcp-server-delete-block-reason";

function summary(
  overrides: Partial<McpServerSummary> & Pick<McpServerSummary, "id" | "name">
): McpServerSummary {
  return {
    assignedProfileCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
    lastError: null,
    status: "disconnected",
    toolCount: 0,
    transport: "http",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mcpServerDeleteBlockReason", () => {
  test("allows deleting unassigned custom servers", () => {
    expect(
      mcpServerDeleteBlockReason(
        summary({ id: "mcp_custom_qa", name: "QA probe" })
      )
    ).toBeNull();
  });

  test("blocks preinstalled servers", () => {
    expect(
      mcpServerDeleteBlockReason(
        summary({
          id: PREINSTALLED_MCP_SERVER_IDS.firecrawl,
          name: "firecrawl",
        })
      )
    ).toBe("Preinstalled MCP servers cannot be deleted.");
  });

  test("explains profile assignments that block deletion", () => {
    expect(
      mcpServerDeleteBlockReason(
        summary({
          assignedProfileCount: 1,
          id: "mcp_custom_qa",
          name: "QA probe",
        })
      )
    ).toBe(
      "Assigned to 1 profile. Unassign on the Profiles page before deleting."
    );

    expect(
      mcpServerDeleteBlockReason(
        summary({
          assignedProfileCount: 3,
          id: "mcp_custom_qa",
          name: "QA probe",
        })
      )
    ).toBe(
      "Assigned to 3 profiles. Unassign on the Profiles page before deleting."
    );
  });
});
