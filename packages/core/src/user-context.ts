export const USER_CONTEXT_TEMPLATE = `# About Me

Who my Atlas assistant should know I am.

- Name / nickname:
- What you do:
- Current projects:
- Tech stack:
- How you like replies (concise, detailed, casual, formal):
- Always:
- Never:
- People or orgs I work with:
`;

export function normalizeUserContextContent(
  raw: string | null | undefined
): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildUserContextStatus(
  raw: string | null | undefined,
  includeContent: boolean
): {
  active: boolean;
  content?: string;
} {
  const content = normalizeUserContextContent(raw);

  if (!includeContent) {
    return {
      active: content !== undefined,
    };
  }

  return {
    active: content !== undefined,
    ...(content === undefined ? {} : { content }),
  };
}
