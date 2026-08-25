import { ATLAS_DOCS_LLMS_URL, listKnowledgeBaseSources } from "./sources";
import { listKnowledgeBaseDocuments } from "./store";

export async function composeKnowledgeBaseCatalog(
  orgId: string,
  profileId: string
): Promise<string> {
  const documents = await listKnowledgeBaseDocuments(orgId, profileId);
  const sources = await listKnowledgeBaseSources();
  const readyDocuments = documents.filter(
    (document) => document.status === "ready"
  );

  if (readyDocuments.length === 0 && sources.length === 0) {
    return "";
  }

  const sections: string[] = [];

  if (readyDocuments.length > 0) {
    sections.push(
      "# Uploaded documents",
      "Treat these as the primary source for organization-specific facts. Use knowledge_base_search before answering questions they could cover; do not substitute general model memory.",
      ...readyDocuments.map(
        (document) => `- ${document.filename} (${document.mediaType})`
      )
    );
  }

  if (sources.length > 0) {
    sections.push(
      "# Atlas documentation",
      `For Atlas product questions, web_fetch ${ATLAS_DOCS_LLMS_URL}, then web_fetch the matching .md page from that index. Do not use knowledge_base_search for inherited docs.`
    );
  }

  return sections.join("\n");
}
