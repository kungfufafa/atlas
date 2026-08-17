import {
  DEFAULT_SETUP_WORKSPACE_NAME,
  DEFAULT_SETUP_WORKSPACE_SLUG,
} from "@atlas/core/setup-validation";

export interface SetupOrganizationDraft {
  name: string;
  slug: string;
}

export interface SetupAccountDraft {
  email: string;
  name: string;
  password: string;
  phone: string;
}

export type SetupAccountPrefill = Pick<
  SetupAccountDraft,
  "email" | "name" | "phone"
>;

export const SETUP_STEPS = [
  { id: 1, label: "Account", required: true },
  { id: 2, label: "Workspace", required: true },
  { id: 3, label: "Provider", required: true },
  { id: 4, label: "About You", required: false },
] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number]["id"];

export interface SetupWizardProps {
  onComplete?: () => void;
}

export const DEFAULT_SETUP_ORGANIZATION: SetupOrganizationDraft = {
  name: DEFAULT_SETUP_WORKSPACE_NAME,
  slug: DEFAULT_SETUP_WORKSPACE_SLUG,
};

const ACCOUNT_PREFILL_KEY = "atlas.setup.account";

export function parseSetupAccountPrefill(
  raw: string | null
): SetupAccountPrefill | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (
      typeof record.email !== "string" ||
      typeof record.name !== "string" ||
      typeof record.phone !== "string"
    ) {
      return null;
    }

    return {
      email: record.email,
      name: record.name,
      phone: record.phone,
    };
  } catch {
    return null;
  }
}

export function readSetupAccountPrefill(): SetupAccountPrefill | null {
  if (typeof window === "undefined") {
    return null;
  }

  return parseSetupAccountPrefill(
    window.sessionStorage.getItem(ACCOUNT_PREFILL_KEY)
  );
}

export function writeSetupAccountPrefill(account: SetupAccountPrefill): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(
    ACCOUNT_PREFILL_KEY,
    JSON.stringify({
      email: account.email,
      name: account.name,
      phone: account.phone,
    })
  );
}

export function clearSetupAccountPrefill(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(ACCOUNT_PREFILL_KEY);
}
