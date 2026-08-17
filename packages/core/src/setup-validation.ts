export const SETUP_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SETUP_PHONE_PATTERN = /^[+0-9()\-\s]{6,32}$/;
export const SETUP_ORG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SETUP_MIN_PASSWORD_LENGTH = 8;
export const DEFAULT_SETUP_WORKSPACE_NAME = "Personal";
export const DEFAULT_SETUP_WORKSPACE_SLUG = "personal";

export function normalizeSetupEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeOptionalSetupPhone(
  phone: string | null | undefined
): string | null {
  const trimmed = phone?.trim() ?? "";
  return trimmed || null;
}

export function slugifySetupWorkspaceName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return slug || DEFAULT_SETUP_WORKSPACE_SLUG;
}

export function validateSetupName(name: string): string | null {
  if (!name.trim()) {
    return "Name is required.";
  }

  return null;
}

export function validateSetupEmail(email: string): string | null {
  const normalized = normalizeSetupEmail(email);
  if (!(normalized && SETUP_EMAIL_PATTERN.test(normalized))) {
    return "A valid email address is required.";
  }

  return null;
}

export function validateSetupPhone(
  phone: string | null | undefined
): string | null {
  const normalized = normalizeOptionalSetupPhone(phone);
  if (!normalized) {
    return null;
  }

  if (!SETUP_PHONE_PATTERN.test(normalized)) {
    return "Enter a valid phone number.";
  }

  return null;
}

export function validateSetupPassword(
  password: string,
  confirmPassword?: string
): string | null {
  if (password.length < SETUP_MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${SETUP_MIN_PASSWORD_LENGTH} characters.`;
  }

  if (confirmPassword !== undefined && password !== confirmPassword) {
    return "Passwords do not match.";
  }

  return null;
}

export function validateSetupWorkspaceName(name: string): string | null {
  if (!name.trim()) {
    return "Workspace name is required.";
  }

  return null;
}

export function validateSetupWorkspaceSlug(slug: string): string | null {
  const normalized = slug.trim().toLowerCase();
  if (!(normalized && SETUP_ORG_SLUG_PATTERN.test(normalized))) {
    return "Slug must use lowercase letters, numbers, and hyphens.";
  }

  return null;
}
