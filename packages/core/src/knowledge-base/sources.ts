import type { KnowledgeBaseSource } from "../contract";

export const ATLAS_DOCS_SITE_URL = "https://kungfufafa.github.io/atlas";
export const NAKAMA_DOCS_LLMS_URL = `${ATLAS_DOCS_SITE_URL}/llms.txt`;

export const DEFAULT_KNOWLEDGE_SOURCES: KnowledgeBaseSource[] = [
  {
    description:
      "Official Atlas docs index (llms.txt). Fetch this first with web_fetch, then fetch specific .md pages listed in the index.",
    enabled: true,
    id: "nakama-docs",
    inherited: true,
    kind: "url",
    title: "Atlas Documentation",
    url: NAKAMA_DOCS_LLMS_URL,
  },
];

export async function listKnowledgeBaseSources(): Promise<
  KnowledgeBaseSource[]
> {
  return DEFAULT_KNOWLEDGE_SOURCES.filter((source) => source.enabled).map(
    (source) => ({
      ...source,
    })
  );
}
