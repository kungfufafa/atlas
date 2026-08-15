import { describe, expect, test } from "bun:test";
import { createPptxBuffer } from "@atlas/core/presentation-engine";
import { artifactService, detectArtifactMimeType } from "./artifact-service";

describe("ArtifactService", () => {
  test("detects common MIME types accurately", () => {
    expect(detectArtifactMimeType("presentation.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    expect(detectArtifactMimeType("document.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(detectArtifactMimeType("chart.png")).toBe("image/png");
    expect(detectArtifactMimeType("vector.svg")).toBe("image/svg+xml");
    expect(detectArtifactMimeType("data.csv")).toBe("text/csv");
    expect(detectArtifactMimeType("sheet.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    expect(detectArtifactMimeType("report.pdf")).toBe("application/pdf");
    expect(detectArtifactMimeType("output.json")).toBe("application/json");
  });

  test("saves, lists, inspects, reads, and deletes artifacts", async () => {
    const orgId = "org_test_art";
    const profileId = "profile_test_art";

    const saved = await artifactService.saveArtifact(
      orgId,
      profileId,
      "test-data.csv",
      "name,value\nalpha,100\nbeta,200",
      { sessionId: "session_123" }
    );

    expect(saved.filename).toBe("test-data.csv");
    expect(saved.mimeType).toBe("text/csv");
    expect(saved.sizeBytes).toBeGreaterThan(0);

    const list = await artifactService.listArtifacts(orgId, profileId);
    expect(list.some((a) => a.filename === "test-data.csv")).toBe(true);

    const read = await artifactService.getArtifact(
      orgId,
      profileId,
      saved.path
    );
    expect(read.content.toString("utf8")).toContain("alpha,100");

    // Save and inspect PPTX
    const pptxBuffer = await createPptxBuffer({
      slides: [
        { title: "Slide 1" },
        { title: "Slide 2" },
        { title: "Slide 3" },
      ],
      title: "Test Deck",
    });

    const pptxSaved = await artifactService.saveArtifact(
      orgId,
      profileId,
      "test-deck.pptx",
      pptxBuffer,
      { sessionId: "session_123" }
    );

    const inspected = await artifactService.inspectArtifact(
      orgId,
      profileId,
      pptxSaved.path
    );

    expect(inspected.type).toBe("presentation");
    expect(inspected.metadata.slideCount).toBe(3);

    await artifactService.deleteArtifact(orgId, profileId, saved.path);
    await artifactService.deleteArtifact(orgId, profileId, pptxSaved.path);
  });
});
