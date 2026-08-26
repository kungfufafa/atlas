import { classifyArtifactCategory } from "@atlas/core/artifact-category";
import type {
  ArtifactFile,
  ArtifactFolderMetadata,
} from "@atlas/core/contract";

export const ARTIFACT_TYPE_FILTERS = [
  "all",
  "markdown",
  "html",
  "image",
  "video",
  "document",
  "text",
  "other",
] as const;

export type ArtifactTypeFilter = (typeof ARTIFACT_TYPE_FILTERS)[number];

export const ARTIFACT_TYPE_FILTER_LABELS: Record<ArtifactTypeFilter, string> = {
  all: "All types",
  document: "Documents",
  html: "HTML",
  image: "Images",
  markdown: "Markdown",
  other: "Other",
  text: "Text",
  video: "Video",
};

export function classifyArtifactType(
  artifact: ArtifactFile
): Exclude<ArtifactTypeFilter, "all"> {
  return classifyArtifactCategory(artifact);
}

export function artifactMatchesTypeFilter(
  artifact: ArtifactFile,
  filter: ArtifactTypeFilter
): boolean {
  return filter === "all" || classifyArtifactType(artifact) === filter;
}

/** Type options present in the list (plus `all`), ordered for the filter menu. */
export function availableArtifactTypeFilters(
  artifacts: ArtifactFile[],
  folders: ArtifactFolderMetadata[] = []
): ArtifactTypeFilter[] {
  const present = new Set(artifacts.map(classifyArtifactType));
  for (const folder of folders) {
    for (const category of Object.keys(folder.typeStats)) {
      present.add(category as Exclude<ArtifactTypeFilter, "all">);
    }
  }
  return ARTIFACT_TYPE_FILTERS.filter(
    (filter) => filter === "all" || present.has(filter)
  );
}
