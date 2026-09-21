import {
  createPptxBuffer,
  PresentationPreviewer,
  SpreadsheetPreviewer,
} from "../../../packages/core/src/index";
import type { ReleaseGateCheck } from "../decision-engine";

export async function runArtifactFidelitySuite(): Promise<ReleaseGateCheck> {
  const start = Date.now();

  try {
    const presentationPreviewer = new PresentationPreviewer();
    const spreadsheetPreviewer = new SpreadsheetPreviewer();

    const mockContext = {
      orgId: "org-test",
      profileId: "profile-test",
      userId: "user-test",
    };

    // 1. Test Presentation Previewer
    const pptxBuffer = await createPptxBuffer({
      company: "Atlas Enterprise",
      slides: [
        {
          layout: "title",
          subtitle: "Enterprise Artifact Preview Platform",
          title: "Q3 AI Strategy Deck",
        },
        {
          bulletPoints: [
            "In-browser interactive preview for all office artifacts",
            "Zero friction review flows for AI deliverables",
          ],
          layout: "content",
          title: "Key Deliverables",
        },
      ],
      themeColor: "2563EB",
      title: "Q3 AI Strategy Deck",
    });

    const pptxPreview = await presentationPreviewer.generate(
      {
        artifactId: "art-deck-1",
        filename: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        path: "artifacts/deck.pptx",
        revision: 1,
        sizeBytes: pptxBuffer.length,
      },
      pptxBuffer,
      {},
      mockContext
    );

    if (!pptxPreview || pptxPreview.status !== "available") {
      throw new Error(
        "PPTX preview generation failed to produce available state"
      );
    }

    if (
      pptxPreview.type !== "presentation" ||
      pptxPreview.slides.length !== 2
    ) {
      throw new Error(
        `Expected 2 slides in PPTX preview, got ${pptxPreview.type === "presentation" ? pptxPreview.slides.length : "non-presentation"}`
      );
    }

    // 2. Test CSV / Spreadsheet Previewer
    const csvBuffer = Buffer.from(
      "SKU,Product Name,Category,Price\nAT-101,Atlas Core,Enterprise,$499.00\nAT-102,Atlas Agent,Team,$199.00\n",
      "utf8"
    );

    const csvPreview = await spreadsheetPreviewer.generate(
      {
        artifactId: "art-csv-1",
        filename: "products.csv",
        mimeType: "text/csv",
        path: "artifacts/products.csv",
        revision: 1,
        sizeBytes: csvBuffer.length,
      },
      csvBuffer,
      {},
      mockContext
    );

    if (!csvPreview || csvPreview.status !== "available") {
      throw new Error("CSV spreadsheet preview generation failed");
    }

    if (
      csvPreview.type !== "spreadsheet" ||
      !csvPreview.activeSheet ||
      csvPreview.activeSheet.data.length < 2
    ) {
      throw new Error("CSV spreadsheet rows missing or malformed");
    }

    return {
      category: "Artifacts",
      durationMs: Date.now() - start,
      id: "artifact_fidelity_suite",
      message:
        "PPTX semantic preview slide count and CSV preview row count verified; editing, rendering fidelity and DOCX/PDF operations are not covered",
      required: true,
      status: "pass",
    };
  } catch (error: any) {
    return {
      category: "Artifacts",
      durationMs: Date.now() - start,
      failureCode: "ARTIFACT_FIDELITY_FAILURE",
      id: "artifact_fidelity_suite",
      message: error.message,
      required: true,
      status: "fail",
    };
  }
}
