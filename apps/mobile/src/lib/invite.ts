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
