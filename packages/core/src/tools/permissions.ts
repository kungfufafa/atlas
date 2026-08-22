import type { ToolCapability, ToolRiskLevel } from "./execution-contract";

export interface ToolApprovalPolicy {
  blockedTools?: string[];
  requireApprovalForDestructive?: boolean;
  requireApprovalForExternalWrite?: boolean;
  requireApprovalForSystem?: boolean;
}

export const DEFAULT_TOOL_CAPABILITIES: Record<string, ToolCapability> = {
  bash: {
    cancellable: true,
    category: "compute",
    id: "bash",
    longRunning: true,
    privileged: true,
    risk: "system",
  },
  calculator: {
    cancellable: false,
    category: "compute",
    id: "calculator",
    longRunning: false,
    privileged: false,
    risk: "read",
  },
  copy_file: {
    cancellable: false,
    category: "filesystem",
    id: "copy_file",
    longRunning: false,
    privileged: false,
    risk: "write",
  },
  create_directory: {
    cancellable: false,
    category: "filesystem",
    id: "create_directory",
    longRunning: false,
    privileged: false,
    risk: "write",
  },
  "create-profile": {
    cancellable: false,
    category: "control",
    id: "create-profile",
    longRunning: false,
    privileged: true,
    risk: "high-impact",
  },
  delete_file: {
    cancellable: false,
    category: "filesystem",
    id: "delete_file",
    longRunning: false,
    privileged: false,
    risk: "destructive",
  },
  edit_file: {
    cancellable: false,
    category: "filesystem",
    id: "edit_file",
    longRunning: false,
    privileged: false,
    risk: "write",
  },
  email: {
    cancellable: true,
    category: "communication",
    id: "email",
    longRunning: false,
    privileged: false,
    requiresAuth: true,
    requiresNetwork: true,
    risk: "external-write",
  },
  extract_document_text: {
    cancellable: false,
    category: "retrieval",
    id: "extract_document_text",
    longRunning: false,
    privileged: false,
    risk: "read",
  },
  file_stat: {
    cancellable: false,
    category: "filesystem",
    id: "file_stat",
    longRunning: false,
    privileged: false,
    risk: "read",
  },
  generate_image: {
    cancellable: true,
    category: "media",
    id: "generate_image",
    longRunning: true,
    privileged: false,
    requiresNetwork: true,
    risk: "write",
  },
  knowledge_base_search: {
    cancellable: false,
    category: "retrieval",
    id: "knowledge_base_search",
    longRunning: false,
    privileged: false,
    risk: "read",
  },
  list_directory: {
    cancellable: false,
    category: "filesystem",
    id: "list_directory",
    longRunning: false,
    privileged: false,
    risk: "read",
  },
  move_file: {
    cancellable: false,
    category: "filesystem",
    id: "move_file",
    longRunning: false,
    privileged: false,
    risk: "write",
  },
  python_execute: {
    cancellable: true,
    category: "compute",
    id: "python_execute",
    longRunning: true,
    privileged: false,
    risk: "system",
  },
  read_file: {
    cancellable: false,
    category: "filesystem",
    id: "read_file",
    longRunning: false,
    privileged: false,
    risk: "read",
  },
  search_files: {
    cancellable: true,
    category: "filesystem",
    id: "search_files",
    longRunning: false,
    privileged: false,
    risk: "read",
  },
  send_whatsapp: {
    cancellable: true,
    category: "communication",
    id: "send_whatsapp",
    longRunning: false,
    privileged: false,
    requiresAuth: true,
    requiresNetwork: true,
    risk: "external-write",
  },
  spreadsheet: {
    cancellable: true,
    category: "artifact",
    id: "spreadsheet",
    longRunning: false,
    privileged: false,
    risk: "write",
  },
  sub_agent: {
    cancellable: true,
    category: "agent",
    id: "sub_agent",
    longRunning: true,
    privileged: false,
    risk: "system",
  },
  tool_search: {
    cancellable: false,
    category: "control",
    id: "tool_search",
    longRunning: false,
    privileged: false,
    risk: "read",
  },
  web_fetch: {
    cancellable: true,
    category: "web",
    id: "web_fetch",
    longRunning: false,
    privileged: false,
    requiresNetwork: true,
    risk: "read",
  },
  web_search: {
    cancellable: true,
    category: "web",
    id: "web_search",
    longRunning: false,
    privileged: false,
    requiresNetwork: true,
    risk: "read",
  },
  write_docx: {
    cancellable: false,
    category: "artifact",
    id: "write_docx",
    longRunning: false,
    privileged: false,
    risk: "write",
  },
  write_file: {
    cancellable: false,
    category: "filesystem",
    id: "write_file",
    longRunning: false,
    privileged: false,
    risk: "write",
  },
};

export function getToolCapability(toolName: string): ToolCapability {
  return (
    DEFAULT_TOOL_CAPABILITIES[toolName] ?? {
      cancellable: true,
      category: "compute",
      id: toolName,
      longRunning: false,
      privileged: false,
      risk: "system",
    }
  );
}

export function getToolRiskLevel(toolName: string): ToolRiskLevel {
  return getToolCapability(toolName).risk;
}

export function evaluateToolApprovalRequired(
  toolName: string,
  policy?: ToolApprovalPolicy
): { reason?: string; requiresApproval: boolean } {
  if (!policy) {
    return { requiresApproval: false };
  }

  if (policy.blockedTools?.includes(toolName)) {
    return {
      reason: `Tool "${toolName}" is blocked by security policy.`,
      requiresApproval: true,
    };
  }

  const capability = getToolCapability(toolName);

  if (
    policy.requireApprovalForDestructive &&
    capability.risk === "destructive"
  ) {
    return {
      reason: `Destructive tool "${toolName}" requires user approval.`,
      requiresApproval: true,
    };
  }

  if (
    policy.requireApprovalForExternalWrite &&
    capability.risk === "external-write"
  ) {
    return {
      reason: `External write tool "${toolName}" requires user approval.`,
      requiresApproval: true,
    };
  }

  if (policy.requireApprovalForSystem && capability.risk === "system") {
    return {
      reason: `System execution tool "${toolName}" requires user approval.`,
      requiresApproval: true,
    };
  }

  return { requiresApproval: false };
}
