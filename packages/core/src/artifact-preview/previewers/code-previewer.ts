import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  type CodePreview,
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
} from "../types";

const CODE_EXTENSIONS: Record<string, string> = {
  ".bash": "bash",
  ".c": "c",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".dart": "dart",
  ".dockerfile": "dockerfile",
  ".env": "shell",
  ".go": "go",
  ".graphql": "graphql",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "jsx",
  ".kt": "kotlin",
  ".lua": "lua",
  ".m": "objectivec",
  ".php": "php",
  ".prisma": "prisma",
  ".py": "python",
  ".r": "r",
  ".rb": "ruby",
  ".rs": "rust",
  ".sass": "sass",
  ".scala": "scala",
  ".scss": "scss",
  ".sh": "bash",
  ".sql": "sql",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".vue": "vue",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zsh": "bash",
  dockerfile: "dockerfile",
};

export function detectCodeLanguage(filename: string): string | null {
  const lower = filename.toLowerCase();
  const basename = lower.split("/").pop() || "";
  if (basename === "dockerfile" || basename.startsWith("dockerfile.")) {
    return "dockerfile";
  }

  const ext = lower.slice(lower.lastIndexOf("."));
  return CODE_EXTENSIONS[ext] || null;
}

export class CodePreviewer implements ArtifactPreviewer {
  readonly type = "code" as const;

  supports(artifact: { filename: string; mimeType: string }): boolean {
    const lang = detectCodeLanguage(artifact.filename);
    return lang !== null;
  }

  async inspect(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    const language = detectCodeLanguage(artifact.filename) || "text";
    const text = buffer.toString("utf8");
    const lineCount = text.split("\n").length;

    return {
      metadata: {
        language,
        lineCount,
      },
      status: "available",
      summary: `${language.toUpperCase()} Source · ${lineCount} line${lineCount === 1 ? "" : "s"}`,
      type: "code",
    };
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    options: PreviewOptions,
    context: PreviewContext
  ): Promise<CodePreview> {
    const targetPath = artifact.path || artifact.filename;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;
    const language = detectCodeLanguage(artifact.filename) || "text";
    const rawContent = buffer.toString("utf8");
    const lines = rawContent.split("\n");
    const maxLines = options.maxLines ?? 5000;
    const truncatedContent = lines.slice(0, maxLines).join("\n");

    return {
      artifactId: artifact.artifactId,
      content: truncatedContent,
      downloadUrl,
      filename: artifact.filename,
      generatedAt: new Date().toISOString(),
      language,
      lineCount: lines.length,
      metadata: {
        language,
        lineCount: lines.length,
        truncated: lines.length > maxLines,
      },
      mimeType: artifact.mimeType || "text/plain",
      previewVersion: PREVIEW_VERSION,
      revision: artifact.revision,
      sizeBytes: artifact.sizeBytes || buffer.length,
      status: "available",
      type: "code",
    };
  }
}
