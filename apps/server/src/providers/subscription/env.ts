import { homedir } from "node:os";
import { join } from "node:path";
import { getUserConfigDir, type SubscriptionProviderKind } from "@atlas/core";
import { getToolExecutionEnv } from "../../lib/ensure-process-path";

const SHARED_RUNTIME_ENV_KEYS = [
  "ALL_PROXY",
  "COMSPEC",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "Path",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "XDG_RUNTIME_DIR",
] as const;

export function subscriptionRuntimeHome(
  kind: SubscriptionProviderKind,
  env: Record<string, string | undefined> = process.env
): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (kind === "chatgpt") {
    const atlasConfigDir = env.ATLAS_CONFIG_DIR?.trim() || getUserConfigDir();
    return join(atlasConfigDir, "subscription-auth", "chatgpt");
  }
  return env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
}

export function buildSubscriptionRuntimeEnv(
  kind: SubscriptionProviderKind,
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  const source: Record<string, string | undefined> = {
    ...getToolExecutionEnv(),
    ...extra,
  };
  const env: Record<string, string | undefined> = {};
  for (const key of SHARED_RUNTIME_ENV_KEYS) {
    if (source[key] !== undefined) {
      env[key] = source[key];
    }
  }

  const home = source.HOME ?? source.USERPROFILE ?? homedir();
  const providerHome = subscriptionRuntimeHome(kind, source);
  env.HOME = home;
  env.USERPROFILE = source.USERPROFILE ?? home;

  if (kind === "chatgpt") {
    env.CODEX_HOME = providerHome;
  } else {
    env.CLAUDE_CONFIG_DIR = providerHome;
    if (source.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
      env.CLAUDE_CODE_OAUTH_TOKEN = source.CLAUDE_CODE_OAUTH_TOKEN;
    }
  }

  return env;
}

export function shouldUseDeviceCodeLogin(
  env: Record<string, string | undefined> = process.env
): boolean {
  const override = env.ATLAS_SUBSCRIPTION_LOGIN?.trim().toLowerCase();
  if (override === "device") {
    return true;
  }
  if (override === "browser") {
    return false;
  }
  if (env.SSH_CONNECTION || env.SSH_TTY) {
    return true;
  }
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return true;
  }
  return false;
}
