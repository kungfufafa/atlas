import { describe, expect, it } from "bun:test";
import { ResearchEngine, validateCitationIntegrity } from "./research-engine";

describe("Research Engine, Delta Research & Citation Integrity", () => {
  const engine = new ResearchEngine();

  it("Executes initial research and produces structured citations and sources", async () => {
    const result = await engine.executeResearch("Vector Database Indexing");

    expect(result.sourcesCount).toBeGreaterThan(0);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.structuredCitations?.length).toBeGreaterThan(0);
    expect(result.researchSession?.revision).toBe(1);

    const integrity = validateCitationIntegrity(
      result.structuredCitations || [],
      result.evidence,
      result.sources
    );
    expect(integrity.valid).toBe(true);
    expect(integrity.errors.length).toBe(0);
  });

  it("Delta Research: reuses previous evidence, increments revision, and maintains provenance", async () => {
    const initialResult = await engine.executeResearch("OpenAI vs Anthropic");
    const priorSession = initialResult.researchSession;

    expect(priorSession).toBeDefined();
    if (!priorSession) {
      return;
    }

    // Follow-up research: "Add Gemini"
    const deltaResult = await engine.executeResearch("Add Gemini", {
      focusAreas: ["Gemini 1.5 Pro multimodal capabilities"],
      priorSession,
    });

    expect(deltaResult.researchSession?.revision).toBe(2);
    expect(deltaResult.researchSession?.parentRevisionId).toBe(priorSession.id);
    expect(deltaResult.evidence.length).toBeGreaterThan(0);

    // Verify citation integrity of the delta session
    const integrity = validateCitationIntegrity(
      deltaResult.structuredCitations || [],
      deltaResult.evidence,
      deltaResult.sources
    );
    expect(integrity.valid).toBe(true);
  });

  it("Citation Integrity: catches orphan citations referencing non-existent sources or evidence", () => {
    const badCitation = {
      evidenceIds: ["non-existent-ev-99"],
      id: "cite-bad",
      sourceId: "non-existent-source-99",
    };

    const integrity = validateCitationIntegrity([badCitation], [], []);

    expect(integrity.valid).toBe(false);
    expect(integrity.errors.length).toBeGreaterThan(0);
    expect(integrity.errors.some((e) => e.includes("missing source"))).toBe(
      true
    );
    expect(integrity.errors.some((e) => e.includes("missing evidence"))).toBe(
      true
    );
  });
});
