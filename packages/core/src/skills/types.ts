export interface SkillFrontmatter {
  description: string;
  /** When true, the skill only activates on explicit invocation (e.g. /skill name). */
  disableModelInvocation?: boolean;
  /** When true, auto-matched skills include full body text in the prompt. */
  includeBodyOnMatch?: boolean;
  name: string;
}

export interface ParsedSkillFile {
  body: string;
  frontmatter: SkillFrontmatter;
  sourcePath: string;
}

export interface DiscoveredSkill {
  body: string;
  description: string;
  directory: string;
  disableModelInvocation: boolean;
  hasTool: boolean;
  includeBodyOnMatch: boolean;
  name: string;
  skillFilePath: string;
  toolPath: string | null;
}

export interface SkillMatchOptions {
  explicitOnly?: boolean;
  outcomes?: Array<{
    helpful?: boolean | null;
    skillName: string;
    useCount?: number;
  }>;
  /** Optional ranker (JS BM25 by default; FTS5 adapters are compatible). */
  ranker?: {
    rank<T extends { description: string; name: string }>(
      skills: T[],
      userMessage: string,
      outcomes?: Array<{
        helpful?: boolean | null;
        skillName: string;
        useCount?: number;
      }>
    ): Array<{ confidence: number; score: number; skill: T }>;
    retrieve?<T extends { description: string; name: string }>(
      skills: T[],
      userMessage: string
    ): T[];
  };
}
