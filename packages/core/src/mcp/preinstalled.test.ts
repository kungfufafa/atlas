import { describe, expect, test } from "bun:test";
import {
  isPreinstalledMcpServerId,
  PREINSTALLED_MCP_SERVER_IDS,
  preinstalledMcpServerIdForOrg,
} from "./preinstalled";

describe("preinstalled MCP server ids", () => {
  test("recognizes catalog ids and per-workspace copies", () => {
    expect(isPreinstalledMcpServerId(PREINSTALLED_MCP_SERVER_IDS.exa)).toBe(
      true
    );
    expect(
      isPreinstalledMcpServerId(
        preinstalledMcpServerIdForOrg(PREINSTALLED_MCP_SERVER_IDS.exa, "org_a")
      )
    ).toBe(true);
    expect(isPreinstalledMcpServerId("mcp_custom")).toBe(false);
  });
});
