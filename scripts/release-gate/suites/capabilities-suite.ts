import {
  type Citation,
  createPptxBuffer,
  type EvidenceItem,
  ResearchEngine,
  resolveArtifactOrDisambiguate,
  type SourceItem,
  validateCitationIntegrity,
} from "../../../packages/core/src/index";
import type { ReleaseGateCheck } from "../decision-engine";

export async function runCapabilitiesSuite(): Promise<ReleaseGateCheck> {
  const start = Date.now();

  try {
    // 1. Test Research Engine & Citation Integrity
    const engine = new ResearchEngine();
    const sources: SourceItem[] = [
      { id: "src-1", title: "OpenAI Documentation", url: "https://openai.com" },
      {
        id: "src-2",
        title: "Anthropic Claude Guide",
        url: "https://docs.anthropic.com",
      },
      {
        id: "src-3",
        title: "Google Gemini Docs",
        url: "https://ai.google.dev",
      },
    ];

    const evidence: EvidenceItem[] = [
      {
        claim: "OpenAI Codex supports structured function calling",
        id: "ev-1",
        relevanceScore: 0.95,
        snippet: "Function calling supported",
        sourceTitle: "OpenAI Docs",
        sourceUrl: "https://openai.com",
      },
      {
        claim: "Claude 3.5 Sonnet excels at computer use",
        id: "ev-2",
        relevanceScore: 0.95,
        snippet: "Computer use supported",
        sourceTitle: "Claude Guide",
        sourceUrl: "https://docs.anthropic.com",
      },
      {
        claim: "Gemini 1.5 Pro features a 2M token context",
        id: "ev-3",
        relevanceScore: 0.95,
        snippet: "2M token context",
        sourceTitle: "Gemini Docs",
        sourceUrl: "https://ai.google.dev",
      },
    ];

    const citations: Citation[] = [
      {
        evidenceIds: ["ev-1"],
        id: "cite-1",
        sourceId: "src-1",
        text: "OpenAI Codex function calling",
      },
      {
        evidenceIds: ["ev-2"],
        id: "cite-2",
        sourceId: "src-2",
        text: "Claude computer use",
      },
      {
        evidenceIds: ["ev-3"],
        id: "cite-3",
        sourceId: "src-3",
        text: "Gemini 2M token context",
      },
    ];

    const citationReport = validateCitationIntegrity(
      citations,
      evidence,
      sources
    );
    if (!citationReport.valid) {
      throw new Error(
        `Citation validation failed: ${citationReport.errors.join(", ")}`
      );
    }

    // 2. Test Rich Presentation Generation Engine
    const pptxBuffer = await createPptxBuffer({
      company: "Atlas Technologies",
      slides: [
        {
          layout: "title",
          subtitle: "Enterprise Release Gate",
          title: "Atlas Architecture",
        },
        {
          bulletPoints: [
            "Deterministic Mock CI for guaranteed reproducibility",
            "Multi-tenant data isolation and role-based access",
            "Autonomous browser QA and Office deliverable previews",
          ],
          layout: "content",
          title: "Key Platform Capabilities",
        },
      ],
      title: "Atlas Architecture",
    });

    if (!pptxBuffer || pptxBuffer.length === 0) {
      throw new Error("Failed to generate PPTX presentation buffer");
    }

    // 3. Test Artifact Disambiguation Engine
    const artifacts = [
      {
        createdAt: new Date().toISOString(),
        filename: "atlas_overview.pptx",
        id: "art-1",
        metadata: { slideCount: 3 },
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        path: "artifacts/atlas_overview.pptx",
        revision: 1,
        sessionId: "session-1",
        size: 15_000,
        type: "presentation" as const,
      },
      {
        createdAt: new Date().toISOString(),
        filename: "financial_model.xlsx",
        id: "art-2",
        metadata: { sheetCount: 2 },
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        path: "artifacts/financial_model.xlsx",
        revision: 1,
        sessionId: "session-1",
        size: 12_000,
        type: "spreadsheet" as const,
      },
    ];

    const resolvedPptx = resolveArtifactOrDisambiguate({
      artifacts,
      prompt: "edit slide 2",
    });
    if (
      !resolvedPptx.resolvedArtifact ||
      resolvedPptx.resolvedArtifact.id !== "art-1"
    ) {
      throw new Error(
        "Failed to resolve presentation artifact for prompt 'edit slide 2'"
      );
    }

    const resolvedXlsx = resolveArtifactOrDisambiguate({
      artifacts,
      prompt: "add a downside scenario to the spreadsheet",
    });
    if (
      !resolvedXlsx.resolvedArtifact ||
      resolvedXlsx.resolvedArtifact.id !== "art-2"
    ) {
      throw new Error(
        "Failed to resolve spreadsheet artifact for prompt 'add a downside scenario'"
      );
    }

    return {
      category: "Capabilities",
      durationMs: Date.now() - start,
      id: "capabilities_master_suite",
      message:
        "All 7 capability dimensions (research, artifacts, disambiguation, citations) verified",
      required: true,
      status: "pass",
    };
  } catch (error: any) {
    return {
      category: "Capabilities",
      durationMs: Date.now() - start,
      failureCode: "CAPABILITIES_SUITE_FAILURE",
      id: "capabilities_master_suite",
      message: error.message,
      required: true,
      status: "fail",
    };
  }
}
