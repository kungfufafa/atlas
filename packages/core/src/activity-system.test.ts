import { describe, expect, it } from "bun:test";
import {
  evaluateActionRiskAssessment,
  mapToolCallToActivity,
  updateActivityCompletion,
} from "./activity-system";

describe("activity-system", () => {
  it("maps web_search to calm semantic search activity", () => {
    const activity = mapToolCallToActivity("call_1", "web_search", {
      query: "bun runtime vs node",
    });
    expect(activity.id).toBe("call_1");
    expect(activity.type).toBe("search");
    expect(activity.label).toBe("Searching the web");
    expect(activity.detail).toBe('"bun runtime vs node"');
    expect(activity.status).toBe("running");
  });

  it("maps web_fetch to reading sources with domain", () => {
    const activity = mapToolCallToActivity("call_2", "web_fetch", {
      url: "https://docs.anthropic.com/en/docs/overview",
    });
    expect(activity.type).toBe("read");
    expect(activity.label).toBe("Reading sources");
    expect(activity.detail).toBe("docs.anthropic.com");
  });

  it("maps python_execute to analyzing data", () => {
    const activity = mapToolCallToActivity("call_3", "python_execute", {
      code: "print(2**16)",
    });
    expect(activity.type).toBe("analyze");
    expect(activity.label).toBe("Analyzing data");
  });

  it("maps spreadsheet creation and inspection", () => {
    const actCreate = mapToolCallToActivity("call_4", "spreadsheet", {
      action: "create",
      filename: "financial_model.xlsx",
    });
    expect(actCreate.type).toBe("create");
    expect(actCreate.label).toBe("Creating spreadsheet");
    expect(actCreate.detail).toBe("financial_model.xlsx");

    const actInspect = mapToolCallToActivity("call_5", "spreadsheet", {
      action: "inspect",
      filename: "financial_model.xlsx",
    });
    expect(actInspect.type).toBe("read");
    expect(actInspect.label).toBe("Reading spreadsheet");
  });

  it("maps write_pptx to building presentation", () => {
    const activity = mapToolCallToActivity("call_6", "write_pptx", {
      title: "AI Strategy Q3",
    });
    expect(activity.type).toBe("create");
    expect(activity.label).toBe("Building presentation");
    expect(activity.detail).toBe("AI Strategy Q3");
  });

  it("maps browser actions to calm navigation labels", () => {
    const actOpen = mapToolCallToActivity("call_7", "browser", {
      action: "open",
      url: "https://store.example.com",
    });
    expect(actOpen.type).toBe("browse");
    expect(actOpen.label).toBe("Opening store.example.com");

    const actNav = mapToolCallToActivity("call_8", "browser", {
      action: "click",
      selector: "button.checkout",
    });
    expect(actNav.type).toBe("browse");
    expect(actNav.label).toBe("Navigating page");
  });

  it("maps search_chats and memory tools", () => {
    const actChats = mapToolCallToActivity("call_9", "search_chats", {
      query: "Apollo launch date",
    });
    expect(actChats.type).toBe("retrieve");
    expect(actChats.label).toBe("Searching previous chats");

    const actMem = mapToolCallToActivity("call_10", "memory_search", {});
    expect(actMem.type).toBe("retrieve");
    expect(actMem.label).toBe("Checking memory");
  });

  it("maps MCP tools to connected app activities", () => {
    const actGithub = mapToolCallToActivity(
      "call_11",
      "mcp__github__search_issues",
      { query: "is:open label:bug" }
    );
    expect(actGithub.type).toBe("connect");
    expect(actGithub.label).toBe("Working with Github");
  });

  it("updates activity completion status", () => {
    const act = mapToolCallToActivity("call_12", "python_execute", {});
    const completed = updateActivityCompletion(act, true);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();

    const failed = updateActivityCompletion(act, false, "Execution timeout");
    expect(failed.status).toBe("failed");
    expect(failed.detail).toBe("Execution timeout");
  });

  it("evaluates action risk and consequences", () => {
    const safeRisk = evaluateActionRiskAssessment("web_search", {
      query: "weather",
    });
    expect(safeRisk.requiresApproval).toBe(false);
    expect(safeRisk.riskLevel).toBe("low");

    const purchaseRisk = evaluateActionRiskAssessment("browser", {
      action: "submit_order",
      amount: "$129.00",
      item: "Atlas Pro",
    });
    expect(purchaseRisk.requiresApproval).toBe(true);
    expect(purchaseRisk.riskLevel).toBe("high");
    expect(purchaseRisk.consequenceSummary).toContain(
      "submit this order for Atlas Pro ($129.00)"
    );

    const deleteRisk = evaluateActionRiskAssessment("filesystem", {
      action: "delete",
      filename: "database.sqlite",
    });
    expect(deleteRisk.requiresApproval).toBe(true);
    expect(deleteRisk.riskLevel).toBe("high");
    expect(deleteRisk.consequenceSummary).toContain("permanently delete");
  });
});
