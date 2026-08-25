import {
  assertCanonicalPrincipal,
  type CanonicalPrincipal,
} from "../identity/principal";
import { computeActionHash, evaluateActionRisk } from "../risk-engine";

export interface ActionDescriptor {
  actionHash: string;
  args: Record<string, unknown>;
  orgId: string;
  principalUserId: string;
  requiresApproval: boolean;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  tool: string;
}

export class ActionDescriptorError extends Error {
  readonly code = "ACTION_DESCRIPTOR";

  constructor(message: string) {
    super(message);
    this.name = "ActionDescriptorError";
  }
}

export function describeAction(input: {
  args: Record<string, unknown>;
  principal: CanonicalPrincipal;
  tool: string;
}): ActionDescriptor {
  const principal = assertCanonicalPrincipal(input.principal);
  const tool = input.tool.trim();
  if (!tool) {
    throw new ActionDescriptorError("ActionDescriptor.tool is required.");
  }
  const risk = evaluateActionRisk(tool, input.args);
  return {
    actionHash: computeActionHash({ args: input.args, tool }),
    args: input.args,
    orgId: principal.orgId,
    principalUserId: principal.userId,
    requiresApproval: risk.requiresApproval,
    riskLevel: risk.riskLevel,
    tool,
  };
}
