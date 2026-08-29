const KB_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md", ".csv"]);

export function isKnowledgeBaseFilename(filename: string): boolean {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return KB_EXTENSIONS.has(extension);
}
