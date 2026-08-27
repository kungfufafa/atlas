import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface ProvisionedEnvironment {
  artifactsDir: string;
  browserDir: string;
  configDir: string;
  configPath: string;
  databasePath: string;
  databaseUrl: string;
  destroy: () => Promise<void>;
  logsDir: string;
  previewsDir: string;
  restoreEnv: () => void;
  root: string;
  runId: string;
  screenshotsDir: string;
  tmpDir: string;
  uploadsDir: string;
  verifyDeveloperEnvironmentUntouched: () => boolean;
  workersDir: string;
}

export interface ProvisionOptions {
  mockPort?: number;
  runId?: string;
}

export function generateRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `gate_${timestamp}_${randomSuffix}`;
}

export async function provisionIsolatedEnvironment(
  options: ProvisionOptions = {}
): Promise<ProvisionedEnvironment> {
  const runId = options.runId ?? generateRunId();
  const root = join(tmpdir(), "atlas-e2e", runId);

  // Define isolated subdirectories
  const dbDir = join(root, "db");
  const configDir = join(root, "config");
  const artifactsDir = join(root, "artifacts");
  const uploadsDir = join(root, "uploads");
  const previewsDir = join(root, "previews");
  const browserDir = join(root, "browser");
  const logsDir = join(root, "logs");
  const screenshotsDir = join(root, "screenshots");
  const workersDir = join(root, "workers");
  const tmpDir = join(root, "tmp");

  for (const dir of [
    root,
    dbDir,
    configDir,
    artifactsDir,
    uploadsDir,
    previewsDir,
    browserDir,
    logsDir,
    screenshotsDir,
    workersDir,
    tmpDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const databasePath = join(dbDir, "atlas.sqlite");
  const databaseUrl = `file:${databasePath}`;
  const configPath = join(configDir, "config.ini");

  const mockPort = options.mockPort ?? 11_435;
  const mockBaseUrl = `http://127.0.0.1:${mockPort}/v1`;

  // Write isolated config.ini with mock provider
  const initialConfigIni = `timezone = UTC
thinking_enabled = true
thinking_effort = medium
default_provider_id = prov-mock-ci

[provider.prov-mock-ci]
id = prov-mock-ci
type = openai_compatible
label = Mock CI Provider
base_url = ${mockBaseUrl}
api_key = sk-ci-mock-key
capabilities_json = {"chat.reasoning":{"source":"admin-override","status":"supported","verified":true},"chat.tool-use":{"source":"admin-override","status":"supported","verified":true}}
created_at = ${new Date().toISOString()}
custom_models = [{"id":"mock-model","name":"Mock CI Model","contextLength":128000,"supportsThinking":true}]
`;

  writeFileSync(configPath, initialConfigIni, "utf8");

  // Record developer ~/.atlas snapshot
  const developerAtlasDir = join(homedir(), ".atlas");
  const devAtlasExists = existsSync(developerAtlasDir);
  let devAtlasMtime = 0;
  if (devAtlasExists) {
    try {
      devAtlasMtime = statSync(developerAtlasDir).mtimeMs;
    } catch {
      // ignore
    }
  }

  // Save current process.env
  const originalEnv = {
    ATLAS_CONFIG_DIR: process.env.ATLAS_CONFIG_DIR,
    ATLAS_ENV: process.env.ATLAS_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    TMPDIR: process.env.TMPDIR,
  };

  // Set isolated environment variables
  process.env.ATLAS_CONFIG_DIR = configDir;
  process.env.DATABASE_URL = databaseUrl;
  process.env.ATLAS_ENV = "e2e";
  process.env.NODE_ENV = "test";
  process.env.TMPDIR = tmpDir;

  const restoreEnv = () => {
    if (originalEnv.ATLAS_CONFIG_DIR === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = originalEnv.ATLAS_CONFIG_DIR;
    }

    if (originalEnv.DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    }

    if (originalEnv.ATLAS_ENV === undefined) {
      delete process.env.ATLAS_ENV;
    } else {
      process.env.ATLAS_ENV = originalEnv.ATLAS_ENV;
    }

    if (originalEnv.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    }

    if (originalEnv.TMPDIR === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalEnv.TMPDIR;
    }
  };

  const verifyDeveloperEnvironmentUntouched = (): boolean => {
    if (!devAtlasExists) {
      return !existsSync(developerAtlasDir);
    }
    try {
      const currentStat = statSync(developerAtlasDir);
      // Ensure mtime has not been modified
      return Math.abs(currentStat.mtimeMs - devAtlasMtime) < 1000;
    } catch {
      return false;
    }
  };

  const destroy = async () => {
    restoreEnv();
    try {
      if (existsSync(root)) {
        rmSync(root, { force: true, recursive: true });
      }
    } catch (err) {
      console.warn(`Could not completely remove test root ${root}:`, err);
    }
  };

  return {
    artifactsDir,
    browserDir,
    configDir,
    configPath,
    databasePath,
    databaseUrl,
    destroy,
    logsDir,
    previewsDir,
    restoreEnv,
    root,
    runId,
    screenshotsDir,
    tmpDir,
    uploadsDir,
    verifyDeveloperEnvironmentUntouched,
    workersDir,
  };
}
