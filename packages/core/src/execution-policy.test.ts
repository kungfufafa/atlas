import { describe, expect, it } from "bun:test";
import {
  createExecutionAttempt,
  overrideExecutionAttempt,
  resolveExecutionPolicyWithSource,
} from "./execution-policy";

describe("Execution Policy Resolution & Policy Matrix", () => {
  it("Explicit selection wins over prompt content and heuristics", () => {
    // Even if prompt is research-heavy, explicit 'fast' must win
    const res = resolveExecutionPolicyWithSource({
      prompt: "deep research market comparison across 50 sources",
      userPolicy: "fast",
    });
    expect(res.policy).toBe("fast");
    expect(res.source).toBe("explicit");
    expect(res.displayLabel).toBe("Fast");

    // Explicit agent wins
    const resAgent = resolveExecutionPolicyWithSource({
      prompt: "2 + 2",
      userPolicy: "agent",
    });
    expect(resAgent.policy).toBe("agent");
    expect(resAgent.source).toBe("explicit");
  });

  it("Auto Mode: classifies math queries into Fast with transparent label", () => {
    const res = resolveExecutionPolicyWithSource({
      prompt: "Calculate (12500 * 17.5) / 7",
      userPolicy: "auto",
    });
    expect(res.policy).toBe("fast");
    expect(res.source).toBe("auto");
    expect(res.displayLabel).toBe("Auto: Fast");
  });

  it("Auto Mode: classifies research intent into Research with transparent label", () => {
    const res = resolveExecutionPolicyWithSource({
      prompt: "research vector search indexing algorithms and compare sources",
      userPolicy: "auto",
    });
    expect(res.policy).toBe("research");
    expect(res.source).toBe("auto");
    expect(res.displayLabel).toBe("Auto: Research");
  });

  it("Auto Mode: classifies browser/purchase/agent intent into Agent with transparent label", () => {
    const res = resolveExecutionPolicyWithSource({
      prompt: "open the test shop and place the order for Atlas Pro",
      userPolicy: "auto",
    });
    expect(res.policy).toBe("agent");
    expect(res.source).toBe("auto");
    expect(res.displayLabel).toBe("Auto: Agent");
  });

  it("Auto Mode: defaults to Standard for conversational or file prompts", () => {
    const res = resolveExecutionPolicyWithSource({
      prompt: "Explain the architectural differences between SQL and NoSQL",
      userPolicy: "auto",
    });
    expect(res.policy).toBe("standard");
    expect(res.source).toBe("auto");
    expect(res.displayLabel).toBe("Auto: Standard");
  });

  it("Attachments: prevents Fast downgrade when files are attached to simple math", () => {
    const res = resolveExecutionPolicyWithSource({
      documents: [{ data: "abc", filename: "data.csv", mediaType: "text/csv" }],
      prompt: "what is 2 + 2",
      userPolicy: "auto",
    });
    expect(res.policy).toBe("standard");
  });

  it("Execution Attempt Immutability & Policy Override Lifecycle", () => {
    const initialResolution = resolveExecutionPolicyWithSource({
      prompt: "what is 5 * 10",
      userPolicy: "auto",
    });
    expect(initialResolution.policy).toBe("fast");

    const attempt1 = createExecutionAttempt({
      messageId: "msg-1",
      policyResolution: initialResolution,
      requestedPolicy: "auto",
      sessionId: "sess-1",
    });

    expect(attempt1.status).toBe("queued");
    expect(attempt1.resolvedPolicy).toBe("fast");
    expect(attempt1.policySource).toBe("auto");

    // User switches policy to Research mid-flight
    const { cancelledAttempt, newAttempt } = overrideExecutionAttempt(
      attempt1,
      "research"
    );

    expect(cancelledAttempt.status).toBe("cancelled");
    expect(cancelledAttempt.completedAt).toBeDefined();

    expect(newAttempt.status).toBe("queued");
    expect(newAttempt.parentAttemptId).toBe(attempt1.id);
    expect(newAttempt.resolvedPolicy).toBe("research");
    expect(newAttempt.policySource).toBe("override");
    expect(newAttempt.sessionId).toBe(attempt1.sessionId);
    expect(newAttempt.messageId).toBe(attempt1.messageId);
  });
});
