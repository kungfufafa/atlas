import { join } from "node:path";
import { maskSecret } from "./email-config";
import { parseSentryDsn } from "./error-tracking-dsn";
import { parseIni, readTextOrNull, writeTextFile } from "./fs";
import { getUserConfigDir } from "./user-config";

export interface ErrorTrackingConfig {
  dsn: string | null;
}

const TRUTHY_VALUES = new Set(["1", "true", "on", "yes"]);

function removeLegacyDsnSecret(value: string): string {
  try {
    const url = new URL(value);
    if (!url.password) {
      return value;
    }

    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function getErrorTrackingConfigDir(): string {
  return join(getUserConfigDir(), "error-tracking");
}

export function getErrorTrackingConfigPath(): string {
  return join(getErrorTrackingConfigDir(), "config.ini");
}

export function getErrorTrackingFingerprintKeyPath(): string {
  return join(getErrorTrackingConfigDir(), "fingerprint.key");
}

export async function loadErrorTrackingConfig(): Promise<ErrorTrackingConfig> {
  const raw = await readTextOrNull(getErrorTrackingConfigPath());

  if (raw === null) {
    return { dsn: null };
  }

  return { dsn: parseIni(raw).dsn?.trim() || null };
}

/**
 * DO_NOT_TRACK is checked centrally so it always overrides both environment and
 * file configuration. An explicitly empty environment value disables delivery.
 */
export function resolveErrorTrackingDsn(
  file: ErrorTrackingConfig,
  env: Record<string, string | undefined> = process.env
): string | null {
  if (TRUTHY_VALUES.has(env.DO_NOT_TRACK?.trim().toLowerCase() ?? "")) {
    return null;
  }

  const environmentDsn = env.ATLAS_ERROR_TRACKING_DSN;

  if (environmentDsn !== undefined) {
    return environmentDsn.trim() || null;
  }

  return file.dsn;
}

/** Call refreshErrorTrackingEnabled after saving in a running process. */
export async function saveErrorTrackingDsn(
  dsn: string | null
): Promise<ErrorTrackingConfig> {
  const trimmed = dsn?.trim();
  const next: ErrorTrackingConfig = {
    dsn: trimmed ? removeLegacyDsnSecret(trimmed) : null,
  };
  const lines = [
    "# Atlas error tracking",
    "# dsn = a Sentry-compatible DSN (Sentry, GlitchTip, Bugsink, self-hosted).",
    "# Empty or missing sends nothing. DO_NOT_TRACK=1 overrides this file.",
    ...(next.dsn ? [`dsn=${next.dsn}`] : []),
    "",
  ];

  await writeTextFile(getErrorTrackingConfigPath(), lines.join("\n"), {
    ensureDir: getErrorTrackingConfigDir(),
  });
  return next;
}

export async function isErrorTrackingEnabled(): Promise<boolean> {
  return (
    parseSentryDsn(
      resolveErrorTrackingDsn(await loadErrorTrackingConfig()) ?? ""
    ) !== null
  );
}

export interface ErrorTrackingSettingsPublic {
  configurationSource: "environment" | "settings" | null;
  configured: boolean;
  disabledByDoNotTrack: boolean;
  dsnMasked: string | null;
}

/** The raw DSN contains an ingest key and must never leave the server. */
export async function loadErrorTrackingSettingsPublic(
  env: Record<string, string | undefined> = process.env
): Promise<ErrorTrackingSettingsPublic> {
  const file = await loadErrorTrackingConfig();
  const effectiveDsn = resolveErrorTrackingDsn(file, env);
  const validEffectiveDsn = effectiveDsn ? parseSentryDsn(effectiveDsn) : null;
  const disabledByDoNotTrack = TRUTHY_VALUES.has(
    env.DO_NOT_TRACK?.trim().toLowerCase() ?? ""
  );
  const configurationSource =
    env.ATLAS_ERROR_TRACKING_DSN === undefined
      ? file.dsn
        ? "settings"
        : null
      : "environment";

  return {
    configurationSource,
    configured: Boolean(validEffectiveDsn),
    disabledByDoNotTrack,
    dsnMasked: validEffectiveDsn ? maskSecret(effectiveDsn ?? "") : null,
  };
}
