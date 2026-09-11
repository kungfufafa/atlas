import {
  AtlasApiError,
  applyRedactionBoundary,
  type CanonicalPrincipal,
  computeActionHash,
  type ToolApprovalDecision,
  type ToolApprovalInput,
  type ToolExecutionReceipt,
} from "@atlas/core";
import { CHAT_TOOL_APPROVAL_TIMEOUT_MS } from "@atlas/core/chat-tool-approval-timeout";
import { isFailedToolResult } from "@atlas/core/tools/result-status";
import type { DatabaseAdapter } from "@atlas/db";
import type { ExecutionPlaneService } from "./execution-plane-service";

interface PendingChatApproval {
  beforeDecision: () => Promise<void>;
  deciding: boolean;
  orgId: string;
  reject: (reason: unknown) => void;
  resolve: (decision: ToolApprovalDecision) => void;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
}

export interface ChatToolApprovalRequest extends ToolApprovalInput {
  beforeDecision: () => Promise<void>;
  principal: CanonicalPrincipal;
  sessionId: string;
}

export interface ChatToolApprovalDecisionInput {
  approvalId: string;
  decision: "approved" | "denied";
  principal: CanonicalPrincipal;
  sessionId: string;
}

/** Durable approval records authorize only the live, waiting Atlas invocation. */
export class ChatToolApprovalService {
  private readonly pending = new Map<string, PendingChatApproval>();

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly executionPlane: ExecutionPlaneService
  ) {}

  async request(
    input: ChatToolApprovalRequest,
    onPending: () => void
  ): Promise<ToolApprovalDecision> {
    input.signal?.throwIfAborted();
    await input.beforeDecision();
    await this.ensureRun(input);
    if (await this.db.getActionApproval(input.approval.id)) {
      throw new AtlasApiError("This approval has already been requested.", 409);
    }
    const stepIndex = (await this.db.listExecutionSteps(input.runId)).length;
    await this.executionPlane.pauseForApproval({
      approvalId: input.approval.id,
      args: input.call.arguments,
      checkpoint: {
        remainingToolCalls: [input.call],
        resumeStepIndex: stepIndex,
      },
      principal: input.principal,
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex,
      toolCallId: input.call.id,
      toolName: input.call.name,
    });
    await input.beforeDecision();
    input.signal?.throwIfAborted();

    const decision = Promise.withResolvers<ToolApprovalDecision>();
    const pending: PendingChatApproval = {
      beforeDecision: input.beforeDecision,
      deciding: false,
      orgId: input.principal.orgId,
      reject: decision.reject,
      resolve: decision.resolve,
      runId: input.runId,
      sessionId: input.sessionId,
      signal: input.signal,
    };
    this.pending.set(input.approval.id, pending);
    const onAbort = () =>
      this.rejectPending(
        input.approval.id,
        pending,
        input.signal?.reason ??
          new DOMException("Turn cancelled.", "AbortError")
      );
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      this.rejectPending(
        input.approval.id,
        pending,
        new AtlasApiError("The pending approval has expired.", 409)
      );
    }, CHAT_TOOL_APPROVAL_TIMEOUT_MS);
    timeout.unref();
    try {
      onPending();
      return await decision.promise;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      if (this.pending.get(input.approval.id) === pending) {
        this.pending.delete(input.approval.id);
      }
    }
  }

  async decide(input: ChatToolApprovalDecisionInput): Promise<{
    resumed: true;
    status: "approved" | "denied";
  }> {
    const stored = await this.db.getActionApproval(input.approvalId);
    if (
      !stored ||
      stored.orgId !== input.principal.orgId ||
      stored.sessionId !== input.sessionId
    ) {
      throw new AtlasApiError("Approval not found.", 404);
    }
    if (stored.principalUserId !== input.principal.userId) {
      throw new AtlasApiError(
        "Only the requesting user can decide this approval.",
        403
      );
    }
    const pending = this.pending.get(input.approvalId);
    // An HTTP response can be lost after the live invocation resumes. Return the
    // recorded decision without issuing another grant or replaying the action.
    if (!pending && stored.status === input.decision) {
      return { resumed: true, status: input.decision };
    }
    if (!pending) {
      throw new AtlasApiError(
        "The turn is no longer waiting for this approval. Continue the conversation to request a new action.",
        409
      );
    }
    if (pending.deciding) {
      throw new AtlasApiError(
        "This approval decision is already being processed.",
        409
      );
    }
    pending.deciding = true;
    try {
      await pending.beforeDecision();
      pending.signal?.throwIfAborted();
      this.requirePending(input.approvalId, pending);
      const result = await this.executionPlane.decide(input);
      pending.signal?.throwIfAborted();
      this.requirePending(input.approvalId, pending);
      if (input.decision === "approved") {
        if (!result.grantId) {
          throw new Error("Approved action is missing its execution grant.");
        }
        pending.resolve({ decision: "approved", grantId: result.grantId });
      } else {
        pending.resolve({ decision: "denied" });
      }
      this.pending.delete(input.approvalId);
      return { resumed: true, status: input.decision };
    } catch (error) {
      this.rejectPending(input.approvalId, pending, error);
      throw error;
    }
  }

  cancelSession(sessionId: string): void {
    this.cancelWhere((pending) => pending.sessionId === sessionId);
  }

  cancelOrg(orgId: string): void {
    this.cancelWhere((pending) => pending.orgId === orgId);
  }

  async complete(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    results: readonly ToolExecutionReceipt[] = []
  ): Promise<void> {
    this.cancelWhere((pending) => pending.runId === runId);
    const run = await this.db.getExecutionRun(runId);
    if (!run) {
      return;
    }
    for (const step of await this.db.listExecutionSteps(runId)) {
      if (step.status !== "running" && step.status !== "awaiting_approval") {
        continue;
      }
      const receipt = results.find(
        ({ call }) =>
          call.id === step.toolCallId &&
          call.name === step.toolName &&
          computeActionHash({ args: call.arguments, tool: call.name }) ===
            step.argsHash
      );
      let result: unknown;
      if (receipt) {
        try {
          result = JSON.parse(receipt.content);
        } catch {
          result = receipt.content;
        }
      }
      const failed = !receipt || isFailedToolResult(result);
      await this.db.upsertExecutionStep({
        ...step,
        resultJson: receipt
          ? JSON.stringify(applyRedactionBoundary(result, "audit"))
          : JSON.stringify({
              error:
                "No durable tool result was recorded. Verify the action before retrying.",
              errorCode: "UNCONFIRMED_RESULT",
            }),
        status:
          step.status === "awaiting_approval"
            ? "skipped"
            : failed
              ? "failed"
              : "succeeded",
        updatedAt: new Date().toISOString(),
      });
      if (step.approvalId) {
        const approval = await this.db.getActionApproval(step.approvalId);
        if (approval?.status === "pending") {
          await this.db.upsertActionApproval({
            ...approval,
            status: "expired",
          });
        }
      }
    }
    await this.executionPlane.complete(runId, status);
  }

  private async ensureRun(input: ChatToolApprovalRequest): Promise<void> {
    const run = await this.db.getExecutionRun(input.runId);
    if (!run) {
      await this.executionPlane.startChatRun({
        principal: input.principal,
        runId: input.runId,
        sessionId: input.sessionId,
      });
      return;
    }
    if (
      run.orgId !== input.principal.orgId ||
      run.principalUserId !== input.principal.userId ||
      run.sessionId !== input.sessionId ||
      run.kind !== "chat" ||
      run.status !== "running"
    ) {
      throw new AtlasApiError(
        "This chat execution cannot request approval.",
        409
      );
    }
  }

  private requirePending(id: string, pending: PendingChatApproval): void {
    if (this.pending.get(id) !== pending) {
      throw new AtlasApiError("The pending approval was cancelled.", 409);
    }
  }

  private rejectPending(
    id: string,
    pending: PendingChatApproval,
    error: unknown
  ): void {
    if (this.pending.get(id) === pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private cancelWhere(
    matches: (pending: PendingChatApproval) => boolean
  ): void {
    for (const [id, pending] of this.pending) {
      if (matches(pending)) {
        this.rejectPending(
          id,
          pending,
          new DOMException("Turn cancelled.", "AbortError")
        );
      }
    }
  }
}
