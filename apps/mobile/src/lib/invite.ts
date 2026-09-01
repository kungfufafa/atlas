export const INVITE_PATH = "/invite";

export function inviteAcceptPath(token: string): string {
  return `${INVITE_PATH}?${new URLSearchParams({ token }).toString()}`;
}

export function inviteAcceptUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}${inviteAcceptPath(token)}`;
}

export function tokenFromInviteInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.includes("://")) {
    return trimmed;
  }

  try {
    return new URL(trimmed).searchParams.get("token")?.trim() || trimmed;
  } catch {
    return trimmed;
  }
}
