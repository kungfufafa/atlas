import type {
  Artifact,
  ArtifactCandidate,
  ArtifactType,
  DisambiguationOption,
  DisambiguationResult,
} from "./artifact-types";

export interface ResolveArtifactQuery {
  artifacts: Artifact[];
  explicitArtifactId?: string;
  explicitFilename?: string;
  lastReferencedArtifactId?: string;
  prompt: string;
  sessionId?: string;
  targetType?: ArtifactType;
}

/**
 * Hard filters to discard incompatible candidate artifacts before scoring.
 */
export function filterArtifactCandidates(
  query: ResolveArtifactQuery
): Artifact[] {
  const {
    artifacts,
    explicitArtifactId,
    explicitFilename,
    sessionId,
    targetType,
  } = query;

  return artifacts.filter((artifact) => {
    // 1. Session boundary
    if (sessionId && artifact.sessionId && artifact.sessionId !== sessionId) {
      return false;
    }

    // 2. Explicit ID filter
    if (explicitArtifactId && artifact.id !== explicitArtifactId) {
      return false;
    }

    // 3. Explicit Filename filter
    if (
      explicitFilename &&
      artifact.filename.toLowerCase() !== explicitFilename.toLowerCase()
    ) {
      return false;
    }

    // 4. Target Type filter (if explicit)
    if (targetType && artifact.type !== targetType) {
      return false;
    }

    return true;
  });
}

/**
 * Extract semantic artifact type hints from natural user prompts (multilingual).
 */
export function inferTargetTypeFromPrompt(
  prompt: string
): ArtifactType | undefined {
  const text = prompt.toLowerCase();

  if (
    text.includes("slide") ||
    text.includes("presentation") ||
    text.includes("presentasi") ||
    text.includes("deck") ||
    text.includes("powerpoint") ||
    text.includes(".pptx")
  ) {
    return "presentation";
  }

  if (
    text.includes("sheet") ||
    text.includes("spreadsheet") ||
    text.includes("formula") ||
    text.includes("excel") ||
    text.includes("kolom") ||
    text.includes("baris") ||
    text.includes(".xlsx") ||
    text.includes(".csv")
  ) {
    return "spreadsheet";
  }

  if (
    text.includes("laporan") ||
    text.includes("document") ||
    text.includes("dokumen") ||
    text.includes("paragraf") ||
    text.includes("word") ||
    text.includes(".docx") ||
    text.includes(".md")
  ) {
    return "document";
  }

  if (text.includes(".pdf") || text.includes("pdf")) {
    return "pdf";
  }
}

/**
 * Score candidate artifacts based on explicit signals, recency, semantic matching, and prompt alignment.
 */
export function scoreArtifactCandidate(
  artifact: Artifact,
  query: ResolveArtifactQuery
): ArtifactCandidate {
  const promptText = query.prompt.toLowerCase();
  const filename = artifact.filename.toLowerCase();
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, "");
  const inferredType = inferTargetTypeFromPrompt(query.prompt);

  let score = 0;
  const matchReasons: string[] = [];

  // Signal 1: Exact / explicit filename mentioned in prompt (highest weight)
  if (promptText.includes(filename)) {
    score += 0.95;
    matchReasons.push("Exact filename matched in prompt");
  } else if (promptText.includes(nameWithoutExt) && nameWithoutExt.length > 2) {
    score += 0.85;
    matchReasons.push("Base filename matched in prompt");
  }

  // Signal 2: Extension mentioned in prompt
  const ext = filename.slice(filename.lastIndexOf("."));
  if (ext && promptText.includes(ext)) {
    score += 0.35;
    matchReasons.push(`File extension ${ext} matched`);
  }

  // Signal 3: Type keyword alignment
  if (inferredType && artifact.type === inferredType) {
    score += 0.85;
    matchReasons.push(`Artifact type (${artifact.type}) matched prompt intent`);
  }

  // Signal 4: Last referenced in session
  if (
    query.lastReferencedArtifactId &&
    artifact.id === query.lastReferencedArtifactId
  ) {
    score += 0.25;
    matchReasons.push("Last referenced artifact in active conversation");
  }

  // Signal 5: Recency
  if (artifact.updatedAt || artifact.createdAt) {
    const ageMs =
      Date.now() - new Date(artifact.updatedAt || artifact.createdAt).getTime();
    if (ageMs < 300_000) {
      // modified in last 5 minutes
      score += 0.15;
      matchReasons.push("Recently created/modified artifact");
    }
  }

  // Signal 6: Word overlap with filename tokens
  const filenameTokens = nameWithoutExt.split(/[-_.\s]+/).filter(Boolean);
  let tokenMatches = 0;
  for (const token of filenameTokens) {
    if (token.length > 2 && promptText.includes(token)) {
      tokenMatches += 1;
    }
  }
  if (tokenMatches > 0) {
    score += Math.min(0.3, tokenMatches * 0.1);
    matchReasons.push(`${tokenMatches} filename keyword(s) matched`);
  }

  const confidenceScore = Math.min(1.0, Number(score.toFixed(2)));

  return {
    artifact,
    confidenceScore,
    hardFilterPassed: true,
    matchReasons,
  };
}

/**
 * Deterministically resolve an artifact or return a targeted disambiguation request.
 * SAFE RESOLUTION RULE:
 * - topScore >= 0.85
 * - top candidate is unique
 * - score delta with 2nd candidate >= 0.10
 * Otherwise -> MUST NOT MUTATE -> Return targeted disambiguation prompt.
 */
export function resolveArtifactOrDisambiguate(
  query: ResolveArtifactQuery
): DisambiguationResult {
  const filtered = filterArtifactCandidates(query);

  if (filtered.length === 0) {
    return {
      clarificationMessage:
        "No matching artifact found in this session to edit.",
      disambiguationRequired: true,
      options: [],
      topConfidence: 0,
    };
  }

  if (
    filtered.length === 1 &&
    (query.explicitArtifactId || query.explicitFilename)
  ) {
    return {
      disambiguationRequired: false,
      resolvedArtifact: filtered[0],
      topConfidence: 1.0,
    };
  }

  const scoredCandidates = filtered
    .map((art) => scoreArtifactCandidate(art, query))
    .sort((a, b) => b.confidenceScore - a.confidenceScore);

  const top = scoredCandidates[0];
  const second = scoredCandidates[1];

  const hasHighConfidence = top && top.confidenceScore >= 0.85;
  const hasClearMargin =
    !second || top.confidenceScore - second.confidenceScore >= 0.1;

  if (hasHighConfidence && hasClearMargin) {
    return {
      disambiguationRequired: false,
      resolvedArtifact: top.artifact,
      topConfidence: top.confidenceScore,
    };
  }

  // Ambiguous: build targeted clarification options
  const options: DisambiguationOption[] = scoredCandidates
    .slice(0, 4)
    .map((c, idx) => {
      let description = `${c.artifact.type} file (${c.artifact.filename})`;
      if (c.artifact.metadata?.slideCount) {
        description = `${c.artifact.metadata.slideCount} slides`;
      } else if (c.artifact.metadata?.sheetCount) {
        description = `${c.artifact.metadata.sheetCount} sheets`;
      }
      return {
        artifact: c.artifact,
        description,
        id: c.artifact.id,
        label: `${idx + 1}. ${c.artifact.filename} — ${description}`,
      };
    });

  const clarificationLines = [
    "Which artifact would you like to edit?",
    "",
    ...options.map((opt) => opt.label),
  ];

  return {
    clarificationMessage: clarificationLines.join("\n"),
    disambiguationRequired: true,
    options,
    topConfidence: top?.confidenceScore ?? 0,
  };
}

/**
 * Generate a new revision metadata for an edited artifact, ensuring lineage integrity.
 */
export function createArtifactRevision(
  parentArtifact: Artifact,
  newArtifactId: string,
  newPath: string,
  newSizeBytes: number
): Artifact {
  const currentRev = parentArtifact.revision ?? 1;
  const rootId = parentArtifact.rootArtifactId ?? parentArtifact.id;

  return {
    branchId: parentArtifact.branchId,
    createdAt: parentArtifact.createdAt,
    filename: parentArtifact.filename,
    formatDetails: parentArtifact.formatDetails,
    id: newArtifactId,
    metadata: {
      ...parentArtifact.metadata,
      previousRevision: currentRev,
    },
    mimeType: parentArtifact.mimeType,
    parentArtifactId: parentArtifact.id,
    path: newPath,
    projectId: parentArtifact.projectId,
    revision: currentRev + 1,
    rootArtifactId: rootId,
    sessionId: parentArtifact.sessionId,
    size: newSizeBytes,
    type: parentArtifact.type,
    updatedAt: new Date().toISOString(),
  };
}
