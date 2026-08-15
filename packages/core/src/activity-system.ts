import type { ActivityEvent, RiskAssessment } from "./contract";

/**
 * Maps an internal tool call and input arguments to a calm, semantic user-facing ActivityEvent.
 */
export function mapToolCallToActivity(
  toolCallId: string,
  tool: string,
  input: Record<string, unknown> = {}
): ActivityEvent {
  const startedAt = new Date().toISOString();
  const normalizedTool = tool.toLowerCase();

  if (normalizedTool === "web_search") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    return {
      completedAt: undefined,
      detail: query ? `"${query}"` : undefined,
      id: toolCallId,
      label: "Searching the web",
      startedAt,
      status: "running",
      type: "search",
    };
  }

  if (normalizedTool === "web_fetch") {
    const urlStr = typeof input.url === "string" ? input.url : "";
    let domain: string | undefined;
    try {
      if (urlStr) {
        domain = new URL(urlStr).hostname;
      }
    } catch {
      domain = urlStr;
    }

    return {
      completedAt: undefined,
      detail: domain || undefined,
      id: toolCallId,
      label: "Reading sources",
      startedAt,
      status: "running",
      type: "read",
    };
  }

  if (normalizedTool === "python_execute" || normalizedTool === "calculator") {
    return {
      completedAt: undefined,
      detail: undefined,
      id: toolCallId,
      label: "Analyzing data",
      startedAt,
      status: "running",
      type: "analyze",
    };
  }

  if (normalizedTool === "spreadsheet") {
    const action = typeof input.action === "string" ? input.action : "create";
    const filename =
      typeof input.filename === "string" ? input.filename : "spreadsheet.xlsx";
    return {
      completedAt: undefined,
      detail: filename,
      id: toolCallId,
      label: action.includes("inspect")
        ? "Reading spreadsheet"
        : "Creating spreadsheet",
      startedAt,
      status: "running",
      type: action.includes("inspect") ? "read" : "create",
    };
  }

  if (normalizedTool === "write_pptx") {
    const title =
      typeof input.title === "string" ? input.title : "Presentation";
    return {
      completedAt: undefined,
      detail: title,
      id: toolCallId,
      label: "Building presentation",
      startedAt,
      status: "running",
      type: "create",
    };
  }

  if (normalizedTool === "write_docx") {
    const title = typeof input.title === "string" ? input.title : "Document";
    return {
      completedAt: undefined,
      detail: title,
      id: toolCallId,
      label: "Writing document",
      startedAt,
      status: "running",
      type: "create",
    };
  }

  if (normalizedTool === "browser") {
    const action = typeof input.action === "string" ? input.action : "open";
    const urlStr = typeof input.url === "string" ? input.url : "";
    let domain = "";
    try {
      if (urlStr) {
        domain = new URL(urlStr).hostname;
      }
    } catch {
      domain = urlStr;
    }

    let label = "Browsing the web";
    if (action === "navigate" || action === "open") {
      label = domain ? `Opening ${domain}` : "Opening website";
    } else if (action === "click" || action === "type" || action === "fill") {
      label = "Navigating page";
    } else if (action === "extract" || action === "read") {
      label = "Reading page content";
    }

    return {
      completedAt: undefined,
      detail: domain || undefined,
      id: toolCallId,
      label,
      startedAt,
      status: "running",
      type: "browse",
    };
  }

  if (
    normalizedTool === "search_chats" ||
    normalizedTool === "get_conversation"
  ) {
    return {
      completedAt: undefined,
      detail: typeof input.query === "string" ? `"${input.query}"` : undefined,
      id: toolCallId,
      label: "Searching previous chats",
      startedAt,
      status: "running",
      type: "retrieve",
    };
  }

  if (
    normalizedTool === "memory_search" ||
    normalizedTool === "memory_list" ||
    normalizedTool === "read_profile_memory"
  ) {
    return {
      completedAt: undefined,
      detail: undefined,
      id: toolCallId,
      label: "Checking memory",
      startedAt,
      status: "running",
      type: "retrieve",
    };
  }

  if (
    normalizedTool === "memory_write" ||
    normalizedTool === "memory_update" ||
    normalizedTool === "update_profile_memory"
  ) {
    return {
      completedAt: undefined,
      detail: undefined,
      id: toolCallId,
      label: "Updating memory",
      startedAt,
      status: "running",
      type: "write",
    };
  }

  if (normalizedTool === "deep_research") {
    const topic = typeof input.topic === "string" ? input.topic : "";
    return {
      completedAt: undefined,
      detail: topic || undefined,
      id: toolCallId,
      label: "Researching",
      startedAt,
      status: "running",
      type: "search",
    };
  }

  if (normalizedTool === "knowledge_base_search") {
    return {
      completedAt: undefined,
      detail: typeof input.query === "string" ? `"${input.query}"` : undefined,
      id: toolCallId,
      label: "Searching knowledge base",
      startedAt,
      status: "running",
      type: "search",
    };
  }

  // Handle MCP tools (e.g. mcp__github__search_issues -> Working with GitHub)
  if (normalizedTool.startsWith("mcp__") || normalizedTool.startsWith("mcp_")) {
    const parts = tool.split(/[_]{1,2}/);
    const serviceName = parts[1]
      ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1)
      : "Connected App";

    return {
      completedAt: undefined,
      detail: undefined,
      id: toolCallId,
      label: `Working with ${serviceName}`,
      startedAt,
      status: "running",
      type: "connect",
    };
  }

  return {
    completedAt: undefined,
    detail: undefined,
    id: toolCallId,
    label: formatGenericToolLabel(tool),
    startedAt,
    status: "running",
    type: "analyze",
  };
}

function formatGenericToolLabel(tool: string): string {
  const clean = tool.replace(/[_-]/g, " ").trim();
  if (!clean) {
    return "Working…";
  }
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * Updates an activity event when its corresponding tool finishes.
 */
export function updateActivityCompletion(
  activity: ActivityEvent,
  success: boolean,
  errorMessage?: string
): ActivityEvent {
  return {
    ...activity,
    completedAt: new Date().toISOString(),
    detail: errorMessage || activity.detail,
    status: success ? "completed" : "failed",
  };
}

/**
 * Evaluates action risk to determine if a human confirmation is required.
 * Describes consequence in plain user terms (not raw tool names).
 */
export function evaluateActionRiskAssessment(
  tool: string,
  input: Record<string, unknown> = {}
): RiskAssessment {
  const norm = tool.toLowerCase();

  // High consequence actions: external purchase/order
  if (
    norm.includes("order") ||
    norm.includes("purchase") ||
    norm.includes("checkout") ||
    (norm === "browser" &&
      (String(input.action).includes("order") ||
        String(input.action).includes("submit_order") ||
        String(input.intent).includes("order") ||
        String(input.intent).includes("purchase")))
  ) {
    const item = typeof input.item === "string" ? input.item : "Atlas Pro";
    const amount = typeof input.amount === "string" ? input.amount : "$129.00";
    return {
      actionType: "purchase",
      consequenceSummary: `Atlas is ready to submit this order for ${item} (${amount}).`,
      details: input,
      requiresApproval: true,
      riskLevel: "high",
      title: "Confirm Purchase",
    };
  }

  // Deletions
  if (
    norm.includes("delete") ||
    norm.includes("remove") ||
    norm.includes("drop") ||
    (norm === "filesystem" && input.action === "delete")
  ) {
    const target =
      typeof input.path === "string"
        ? input.path
        : typeof input.filename === "string"
          ? input.filename
          : "target item";
    return {
      actionType: "delete",
      consequenceSummary: `Atlas is ready to permanently delete "${target}".`,
      details: input,
      requiresApproval: true,
      riskLevel: "high",
      title: "Confirm Deletion",
    };
  }

  // External messages (email sending, mass message)
  if (
    norm === "email" &&
    (input.action === "send" || typeof input.to === "string")
  ) {
    const recipient = typeof input.to === "string" ? input.to : "recipient";
    return {
      actionType: "external_message",
      consequenceSummary: `Atlas is ready to send an email to ${recipient}.`,
      details: input,
      requiresApproval: true,
      riskLevel: "medium",
      title: "Send External Email",
    };
  }

  // Read-only / safe actions:
  return {
    actionType: "read",
    consequenceSummary: "Safe execution",
    requiresApproval: false,
    riskLevel: "low",
    title: "Safe Action",
  };
}
