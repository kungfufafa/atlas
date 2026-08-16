import { unzipSync } from "fflate";
import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  PREVIEW_VERSION,
  type PresentationPreview,
  type PresentationSlidePreview,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
} from "../types";

function cleanXmlText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSlideXml(
  slideXml: string,
  slideIndex: number,
  notesXml?: string
): PresentationSlidePreview {
  const slide: PresentationSlidePreview = {
    slideIndex,
  };

  // Speaker notes
  if (notesXml) {
    const notesText = cleanXmlText(notesXml);
    if (notesText) {
      slide.notes = notesText;
    }
  }

  // Background color check (e.g. <a:srgbClr val="0F172A"/>)
  const bgMatch = slideXml.match(
    /<p:bg[\s\S]*?<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/
  );
  if (bgMatch?.[1]) {
    slide.backgroundColor = `#${bgMatch[1]}`;
  } else if (slideIndex === 0) {
    slide.backgroundColor = "#0F172A"; // Default dark cover
  } else {
    slide.backgroundColor = "#FFFFFF";
  }

  // Extract Tables (<a:tbl>)
  const tableMatches = [...slideXml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)];
  if (tableMatches.length > 0) {
    for (const tblMatch of tableMatches) {
      const rowMatches = [...tblMatch[0].matchAll(/<a:tr[\s\S]*?<\/a:tr>/g)];
      if (rowMatches.length > 0) {
        const rows: string[][] = [];
        for (const rMatch of rowMatches) {
          const cellMatches = [...rMatch[0].matchAll(/<a:tc[\s\S]*?<\/a:tc>/g)];
          const cells = cellMatches.map((c) => cleanXmlText(c[0]));
          rows.push(cells);
        }

        if (rows.length > 0) {
          slide.table = {
            headers: rows[0],
            rows: rows.slice(1),
          };
          break; // Use the first table
        }
      }
    }
  }

  // Extract all text shapes (<p:sp>)
  const spMatches = [...slideXml.matchAll(/<p:sp[\s\S]*?<\/p:sp>/g)];
  const bulletPoints: string[] = [];
  const textBlocks: string[] = [];

  for (const spMatch of spMatches) {
    const spContent = spMatch[0];
    const isExplicitTitle =
      spContent.includes('type="title"') ||
      spContent.includes('type="ctrTitle"');
    const isExplicitSubtitle = spContent.includes('type="subTitle"');
    const text = cleanXmlText(spContent);

    if (!text) {
      continue;
    }

    // Skip if part of table
    if (
      slide.table &&
      (slide.table.headers.includes(text) ||
        slide.table.rows.some((r) => r.includes(text)))
    ) {
      continue;
    }

    if (isExplicitTitle) {
      slide.title = text;
      continue;
    }

    if (isExplicitSubtitle) {
      slide.subtitle = text;
      continue;
    }

    // If title not yet set, use the first shape
    if (!slide.title) {
      slide.title = text;
      continue;
    }

    // If cover slide and subtitle not set, use second shape as subtitle
    if (slideIndex === 0 && !slide.subtitle) {
      slide.subtitle = text;
      continue;
    }

    // Otherwise check for bullet points vs text blocks
    const pMatches = [...spContent.matchAll(/<a:p[\s\S]*?<\/a:p>/g)];
    for (const pMatch of pMatches) {
      const pContent = pMatch[0];
      const pText = cleanXmlText(pContent);
      if (!pText || pText === slide.title || pText === slide.subtitle) {
        continue;
      }

      const isBullet =
        pContent.includes("<a:buChar") ||
        pContent.includes("<a:buAutoNum") ||
        (pContent.includes("buNone") === false &&
          pContent.includes("<a:pPr") &&
          pContent.includes("lvl="));

      if (isBullet || pText.startsWith("•") || pText.startsWith("-")) {
        bulletPoints.push(pText.replace(/^[•-]\s*/, ""));
      } else {
        textBlocks.push(pText);
      }
    }
  }

  if (bulletPoints.length > 0) {
    slide.bulletPoints = bulletPoints;
  }
  if (textBlocks.length > 0) {
    slide.textBlocks = textBlocks;
  }

  // Layout inference
  if (slideIndex === 0 && (slide.title || slide.subtitle)) {
    slide.layout = "title";
  } else if (slide.table) {
    slide.layout = "content";
  } else if (slide.bulletPoints && slide.bulletPoints.length > 0) {
    slide.layout = "content";
  } else {
    slide.layout = "content";
  }

  return slide;
}

export class PresentationPreviewer implements ArtifactPreviewer {
  readonly type = "presentation" as const;

  supports(artifact: { filename: string; mimeType: string }): boolean {
    const lowerName = artifact.filename.toLowerCase();
    return (
      lowerName.endsWith(".pptx") ||
      lowerName.endsWith(".ppt") ||
      artifact.mimeType ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      artifact.mimeType === "application/vnd.ms-powerpoint"
    );
  }

  async inspect(
    _artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    try {
      const unzipped = unzipSync(new Uint8Array(buffer), {
        filter: (file) =>
          file.name.startsWith("ppt/") &&
          !file.name.includes("..") &&
          file.name.endsWith(".xml"),
      });
      const slideKeys = Object.keys(unzipped)
        .filter((k) => k.startsWith("ppt/slides/slide") && k.endsWith(".xml"))
        .sort((a, b) => {
          const numA = Number.parseInt(
            a.match(/slide(\d+)\.xml/)?.[1] || "0",
            10
          );
          const numB = Number.parseInt(
            b.match(/slide(\d+)\.xml/)?.[1] || "0",
            10
          );
          return numA - numB;
        });

      const slideCount = slideKeys.length || 1;
      let deckTitle: string | undefined;

      if (slideKeys.length > 0) {
        const firstSlideXml = new TextDecoder().decode(unzipped[slideKeys[0]]);
        const firstParsed = parseSlideXml(firstSlideXml, 0);
        deckTitle = firstParsed.title;
      }

      return {
        metadata: {
          slideCount,
          title: deckTitle,
        },
        status: "available",
        summary: `PowerPoint · ${slideCount} slide${slideCount === 1 ? "" : "s"}`,
        type: "presentation",
      };
    } catch {
      return {
        metadata: { slideCount: 1 },
        status: "available",
        summary: "PowerPoint Presentation",
        type: "presentation",
      };
    }
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _options: PreviewOptions,
    context: PreviewContext
  ): Promise<PresentationPreview> {
    const targetPath = artifact.path || artifact.filename;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;

    try {
      const unzipped = unzipSync(new Uint8Array(buffer), {
        filter: (file) =>
          file.name.startsWith("ppt/") &&
          !file.name.includes("..") &&
          file.name.endsWith(".xml"),
      });
      const slideKeys = Object.keys(unzipped)
        .filter((k) => k.startsWith("ppt/slides/slide") && k.endsWith(".xml"))
        .sort((a, b) => {
          const numA = Number.parseInt(
            a.match(/slide(\d+)\.xml/)?.[1] || "0",
            10
          );
          const numB = Number.parseInt(
            b.match(/slide(\d+)\.xml/)?.[1] || "0",
            10
          );
          return numA - numB;
        })
        .slice(0, 100); // Bound maximum slides

      const slides: PresentationSlidePreview[] = [];

      for (let i = 0; i < slideKeys.length; i++) {
        const key = slideKeys[i];
        const slideXml = new TextDecoder().decode(unzipped[key]);
        const slideNumber = key.match(/slide(\d+)\.xml/)?.[1] || `${i + 1}`;
        const noteKey = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
        const notesXml = unzipped[noteKey]
          ? new TextDecoder().decode(unzipped[noteKey])
          : undefined;

        slides.push(parseSlideXml(slideXml, i, notesXml));
      }

      if (slides.length === 0) {
        slides.push({
          layout: "title",
          slideIndex: 0,
          title: artifact.filename.replace(/\.pptx$/i, ""),
        });
      }

      const deckTitle =
        slides[0]?.title || artifact.filename.replace(/\.pptx$/i, "");

      return {
        artifactId: artifact.artifactId,
        aspectRatio: "16:9",
        downloadUrl,
        filename: artifact.filename,
        generatedAt: new Date().toISOString(),
        metadata: {
          slideCount: slides.length,
        },
        mimeType:
          artifact.mimeType ||
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        previewVersion: PREVIEW_VERSION,
        revision: artifact.revision,
        sizeBytes: artifact.sizeBytes || buffer.length,
        slideCount: slides.length,
        slides,
        status: "available",
        themeColor: "#3B82F6",
        title: deckTitle,
        type: "presentation",
      };
    } catch {
      return {
        artifactId: artifact.artifactId,
        downloadUrl,
        error: "Failed to parse PowerPoint presentation",
        filename: artifact.filename,
        generatedAt: new Date().toISOString(),
        mimeType: artifact.mimeType,
        previewVersion: PREVIEW_VERSION,
        sizeBytes: artifact.sizeBytes || buffer.length,
        slideCount: 0,
        slides: [],
        status: "failed",
        type: "presentation",
      };
    }
  }
}
