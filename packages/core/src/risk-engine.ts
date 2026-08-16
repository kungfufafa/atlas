import { createHash } from "node:crypto";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ApprovalPolicy = "never" | "conditional" | "always";

export type DeterministicActionClass =
  | "FINANCIAL"
  | "PURCHASE"
  | "EXTERNAL_COMMUNICATION"
  | "DESTRUCTIVE"
  | "SECURITY_CHANGE"
  | "ROLE_MUTATION"
  | "PERMANENT_EXTERNAL_WRITE";

export interface ActionConsequence {
  affectedResources?: number;
  amount?: number;
  currency?: string;
  irreversible?: boolean;
  recipient?: string;
  target?: string;
  title: string;
}

export interface RiskEvaluation {
  actionClass?: DeterministicActionClass;
  approval: ApprovalPolicy;
  consequence: ActionConsequence;
  reasonCode: string;
  requiresApproval: boolean;
  riskLevel: RiskLevel;
}

export interface RiskPolicyConfig {
  bulkDeleteThreshold?: number;
  bulkFileWriteThreshold?: number;
  externalRecipientThreshold?: number;
  financialApprovalAlways?: boolean;
}

export const DEFAULT_RISK_POLICY_CONFIG: RiskPolicyConfig = {
  bulkDeleteThreshold: 5,
  bulkFileWriteThreshold: 10,
  externalRecipientThreshold: 1,
  financialApprovalAlways: true,
};

/**
 * Deterministically compute a cryptographic SHA-256 hash of a normalized action payload.
 * If any parameter (amount, recipient, target, tool) changes, the hash will change, invalidating stale approvals.
 */
export function computeActionHash(payload: {
  amount?: number;
  args?: Record<string, unknown>;
  operation?: string;
  recipient?: string;
  target?: string;
  tool: string;
}): string {
  const normalized: Record<string, unknown> = {
    amount: payload.amount ?? null,
    args: payload.args ? sortKeys(payload.args) : {},
    operation: payload.operation ?? "",
    recipient: payload.recipient ?? "",
    target: payload.target ?? "",
    tool: payload.tool,
  };

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      sorted[key] = sortKeys(val as Record<string, unknown>);
    } else {
      sorted[key] = val;
    }
  }
  return sorted;
}

/**
 * Evaluates the action risk using Layer 1 (deterministic rules) and configurable thresholds.
 * LLM or user prompts CANNOT downgrade deterministic action classes.
 */
export function evaluateActionRisk(
  toolName: string,
  args: Record<string, unknown> = {},
  config: RiskPolicyConfig = DEFAULT_RISK_POLICY_CONFIG
): RiskEvaluation {
  const normalizedTool = toolName.toLowerCase().trim();

  // --- LAYER 1: DETERMINISTIC ACTION CLASSES ---

  // 1. FINANCIAL / PURCHASE (CRITICAL - always require approval)
  if (
    normalizedTool === "checkout" ||
    normalizedTool === "purchase" ||
    normalizedTool.includes("order") ||
    normalizedTool.includes("buy") ||
    args.isPurchase === true ||
    typeof args.amount === "number" ||
    (typeof args.action === "string" &&
      (args.action.includes("order") ||
        args.action.includes("buy") ||
        args.action.includes("purchase") ||
        args.action.includes("checkout")))
  ) {
    const amount = typeof args.amount === "number" ? args.amount : 129;
    const currency = typeof args.currency === "string" ? args.currency : "USD";
    const product =
      typeof args.product === "string" ? args.product : "Atlas Pro";
    const merchant =
      typeof args.merchant === "string" ? args.merchant : "Atlas Store";

    return {
      actionClass: "PURCHASE",
      approval: "always",
      consequence: {
        amount,
        currency,
        irreversible: true,
        target: `${product} at ${merchant}`,
        title: `Order Placement & Payment ($${amount} ${currency})`,
      },
      reasonCode: "FINANCIAL_PURCHASE_CRITICAL",
      requiresApproval: true,
      riskLevel: "CRITICAL",
    };
  }

  // 2. EXTERNAL COMMUNICATION (HIGH - always require approval)
  if (
    normalizedTool === "email" ||
    normalizedTool === "send_email" ||
    normalizedTool === "send_discord_artifact" ||
    normalizedTool.includes("send_message") ||
    args.recipient ||
    args.to
  ) {
    const recipient = String(args.to || args.recipient || "external-recipient");
    const subject = String(args.subject || "Message from Atlas");

    return {
      actionClass: "EXTERNAL_COMMUNICATION",
      approval: "always",
      consequence: {
        irreversible: true,
        recipient,
        target: subject,
        title: `Send external communication to ${recipient}`,
      },
      reasonCode: "EXTERNAL_COMMUNICATION_HIGH",
      requiresApproval: true,
      riskLevel: "HIGH",
    };
  }

  // 3. DESTRUCTIVE DELETIONS (HIGH / CONDITIONAL based on threshold)
  if (
    normalizedTool === "delete_file" ||
    normalizedTool === "rm" ||
    normalizedTool.includes("delete")
  ) {
    const fileCount = Array.isArray(args.files) ? args.files.length : 1;
    const targetPath = String(args.path || args.filename || "file");
    const isBulk = fileCount >= (config.bulkDeleteThreshold ?? 5);

    return {
      actionClass: "DESTRUCTIVE",
      approval: isBulk ? "always" : "conditional",
      consequence: {
        affectedResources: fileCount,
        irreversible: true,
        target: targetPath,
        title: `Permanently delete ${fileCount} file(s)`,
      },
      reasonCode: isBulk ? "BULK_DESTRUCTIVE_HIGH" : "FILE_DELETION_MEDIUM",
      requiresApproval: true,
      riskLevel: isBulk ? "HIGH" : "MEDIUM",
    };
  }

  // 4. SECURITY / ROLE MUTATIONS (HIGH - always require approval)
  if (
    normalizedTool === "change_user_role" ||
    normalizedTool === "update_org_admin" ||
    normalizedTool === "create-profile" ||
    args.newRole === "admin"
  ) {
    return {
      actionClass: "ROLE_MUTATION",
      approval: "always",
      consequence: {
        irreversible: false,
        target: String(args.userId || args.email || "user"),
        title: "Modify administrative permissions or access control",
      },
      reasonCode: "SECURITY_ROLE_MUTATION_HIGH",
      requiresApproval: true,
      riskLevel: "HIGH",
    };
  }

  // 5. BULK FILE WRITES
  if (normalizedTool === "write_file" || normalizedTool === "edit_file") {
    const fileCount = Array.isArray(args.files) ? args.files.length : 1;
    if (fileCount >= (config.bulkFileWriteThreshold ?? 10)) {
      return {
        actionClass: "PERMANENT_EXTERNAL_WRITE",
        approval: "conditional",
        consequence: {
          affectedResources: fileCount,
          irreversible: false,
          target: "workspace",
          title: `Bulk write operation across ${fileCount} files`,
        },
        reasonCode: "BULK_FILE_WRITE_MEDIUM",
        requiresApproval: true,
        riskLevel: "MEDIUM",
      };
    }
  }

  // 6. READ / SEARCH / COMPUTE (LOW - never require approval)
  return {
    approval: "never",
    consequence: {
      irreversible: false,
      title: `Read or compute via ${toolName}`,
    },
    reasonCode: "READ_ONLY_OR_SAFE_COMPUTE",
    requiresApproval: false,
    riskLevel: "LOW",
  };
}
