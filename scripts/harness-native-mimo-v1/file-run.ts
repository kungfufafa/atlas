import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  atlasSourceHashes,
  hermesSourceHashes,
  sha256,
  shuffle,
} from "../harness-compare/provenance";
import type { FileAtlasRequest } from "./file-atlas-runner";
import {
  createProductRuntimeIdentity,
  finalizeProductRuntimeIdentities,
} from "./product-identity";
import { modelMetadata, verifyModelEvidence } from "./product-model";
import { type ProductUsageEvidence, startProductProxy } from "./product-proxy";
import {
  type ComparisonRun,
  comparisonLimits,
  comparisonModel,
  upstreamEndpoint,
} from "./product-proxy-broker";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evaluationRoot = "/private/tmp/atlas-hermes-evaluation";
const hermesRoot = join(evaluationRoot, "source");
const hermesPython = join(evaluationRoot, "venv/bin/python");
export const filePython =
  "/Users/apriansyahrs/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const defaultRoot = join(evaluationRoot, "native-files-mimo-study-v1");
const protocolPath =
  "docs/architecture/hermes-native-files-mimo-preregistration.md";
const sourcePattern =
  /^(?:file[-_].+|product-(?:proxy|analysis|identity|model)(?:[-.].+)?)\.(?:ts|py|json)$/;
const safeId = /^[a-zA-Z0-9_-]+$/;
const policyHashPattern = /^[a-f0-9]{64}$/;
const markdownLink = /\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g;
const inlineCode = /`([^`]+)`/g;
const trailingPunctuation = /[.,;:!?\])}>]+$/;
const leadingPunctuation = /^[[(<{]+/;
const effectTools = new Set([
  "python_execute",
  "terminal",
  "process",
  "write_file",
  "edit_file",
  "patch",
]);
const sharedDependencies = [
  "scripts/harness-compare/provenance.ts",
  "scripts/harness-compare/tools.ts",
  "scripts/harness-compare/types.ts",
];
export const FILE_FAMILIES = [
  "xlsx_reconciliation",
  "xlsx_surgical_edit",
  "docx_revision",
  "docx_report",
  "pdf_extract",
  "pdf_create",
  "pptx_revision",
  "csv_join",
  "code_fix",
] as const;
export const FILE_BUDGET = {
  maxGeneratedTokens: 12_000,
  maxOutputTokens: 4096,
  maxProviderRequests: 24,
  timeoutMs: 300_000,
};
export const fileShuffleSeed = 20_260_917;
type Family = (typeof FILE_FAMILIES)[number];
type Harness = "atlas" | "hermes";
type Split = "development" | "confirmatory";
type Phase = Split | "pilot";

export interface FileSchedulePair {
  family: Family;
  order: [Harness, Harness];
  pairId: string;
  repetition: number;
  split: Split;
  variant: number;
}

interface FileTask {
  candidateContractSha256?: string;
  expected: unknown;
  family: Family;
  id: string;
  kind: string;
  output: string;
  prompt: string;
  seed: string;
  sources: Record<string, string>;
  split: string;
  testSuiteSha256?: string;
  variant: number;
}

interface NativeObservation {
  artifacts?: Array<{ native?: unknown }>;
  elapsedMs?: number;
  error?: string;
  evidence?: Record<string, unknown>;
  finalText: string;
  framework: Harness;
  nativeEvents: unknown[];
  sessions: Array<{
    id: string;
    initialHistoryCount: number;
    turns: Array<{ input: string; status: string }>;
  }>;
  sourceCopies?: Array<{ path: string; sha256: string }>;
  status: string;
  workspaceFiles?: unknown[];
  workspaceRoot?: string;
}

interface Snapshot {
  atlasHashes: Record<string, string>;
  candidateSourceHash: string;
  controlHashes: Record<string, string>;
  hermesHashes: Record<string, string>;
}

interface FrozenManifest extends Snapshot {
  archives: Record<string, string>;
  budget: typeof FILE_BUDGET;
  candidateContractSha256: string;
  codeSandboxPolicySha256: string;
  endpoint: string;
  model: string;
  runtimeFingerprint: unknown;
  schedules: Record<Split, string>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
async function jsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), { flag: "wx" });
}
async function ledger(directory: string, value: unknown): Promise<void> {
  await appendFile(
    join(directory, "attempts.jsonl"),
    `${JSON.stringify(value)}\n`
  );
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  );
}

async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (true) {
    try {
      if (!inside("/private/tmp", await realpath(ancestor))) {
        throw new Error("Study data must remain under /private/tmp.");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(absolute, { recursive: true });
  const actual = await realpath(absolute);
  if (!inside("/private/tmp", actual) || actual === "/private/tmp") {
    throw new Error("Use a dedicated private study subdirectory.");
  }
  return actual;
}

/** Each family has both first-arm orders in development; repetition reverses order in confirmation. */
export function buildFileSchedule(split: Split): FileSchedulePair[] {
  const variants = split === "development" ? 2 : 3;
  const base: FileSchedulePair[] = [];
  for (const [familyIndex, family] of FILE_FAMILIES.entries()) {
    for (let variant = 0; variant < variants; variant += 1) {
      base.push({
        family,
        order:
          (familyIndex + variant) % 2 === 0
            ? ["atlas", "hermes"]
            : ["hermes", "atlas"],
        pairId: `native-files-${split}-${family}-v${variant}`,
        repetition: 0,
        split,
        variant,
      });
    }
  }
  const result: FileSchedulePair[] = [];
  for (
    let repetition = 0;
    repetition < (split === "development" ? 1 : 2);
    repetition += 1
  ) {
    const repeated = base.map(
      (pair): FileSchedulePair => ({
        ...pair,
        order: repetition ? [pair.order[1], pair.order[0]] : pair.order,
        pairId: `${pair.pairId}-r${repetition}`,
        repetition,
      })
    );
    result.push(...shuffle(repeated, fileShuffleSeed + repetition));
  }
  return result;
}

export async function fileControlHashes(): Promise<Record<string, string>> {
  await verifyModelEvidence();
  const local = (
    await readdir(join(repository, "scripts/harness-native-mimo-v1"))
  )
    .filter((name) => sourcePattern.test(name))
    .map((name) => `scripts/harness-native-mimo-v1/${name}`);
  const hashes: Record<string, string> = {};
  for (const path of [...local, protocolPath, ...sharedDependencies].sort()) {
    hashes[path] = sha256(await readFile(join(repository, path)));
  }
  return hashes;
}

async function snapshot(): Promise<Snapshot> {
  const [atlasHashes, controlHashes, hermesHashes] = await Promise.all([
    atlasSourceHashes(repository),
    fileControlHashes(),
    hermesSourceHashes(hermesRoot),
  ]);
  return {
    atlasHashes,
    candidateSourceHash: sha256(JSON.stringify(atlasHashes)),
    controlHashes,
    hermesHashes,
  };
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} changed; the batch is invalid.`);
  }
}

async function command(
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(args, {
    cwd: options.cwd ?? repository,
    env: {
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      PYTHONDONTWRITEBYTECODE: "1",
      TMPDIR: "/private/tmp",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr, stdout };
  } finally {
    clearTimeout(timeout);
  }
}

async function trustedJsonCommand(
  args: string[],
  timeoutMs = 60_000
): Promise<unknown> {
  const result = await command(args, { timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(
      `Trusted preparation/grading command failed (${result.exitCode}): ${result.stderr}`
    );
  }
  return JSON.parse(result.stdout);
}

async function runtimeFingerprint(): Promise<unknown> {
  const code =
    "import hashlib,importlib.metadata as m,json,sys; names=['pandas','openpyxl','python-docx','python-pptx','pypdf','reportlab','Pillow']; print(json.dumps({'python':sys.version,'executable':sys.executable,'packages':{n:{'version':m.version(n),'recordSha256':hashlib.sha256((m.distribution(n).read_text('RECORD') or '').encode()).hexdigest()} for n in names}}))";
  return {
    executableSha256: sha256(await readFile(filePython)),
    metadata: await trustedJsonCommand([filePython, "-I", "-c", code]),
  };
}

async function policyHash(
  mode: "--policy-sha256" | "--contract-sha256" = "--policy-sha256"
): Promise<string> {
  const output = await command([
    filePython,
    join(repository, "scripts/harness-native-mimo-v1/file-code-check.py"),
    mode,
  ]);
  const hash = output.stdout.trim();
  if (output.exitCode !== 0 || !policyHashPattern.test(hash)) {
    throw new Error(
      `Independent code sandbox policy is not ready: ${output.stderr}`
    );
  }
  return hash;
}

async function archive(
  root: string,
  files: Record<string, string>,
  path: string
): Promise<string> {
  const child = Bun.spawn(["/usr/bin/tar", "-czf", path, "--null", "-T", "-"], {
    cwd: root,
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  child.stdin.write(`${Object.keys(files).join("\0")}\0`);
  child.stdin.end();
  const [, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`Source archive failed: ${stderr}`);
  }
  return sha256(await readFile(path));
}

async function archiveSnapshot(
  directory: string,
  source: Snapshot
): Promise<Record<string, string>> {
  const result = {
    "atlas-source.tar.gz": await archive(
      repository,
      source.atlasHashes,
      join(directory, "atlas-source.tar.gz")
    ),
    "file-protocol-source.tar.gz": await archive(
      repository,
      source.controlHashes,
      join(directory, "file-protocol-source.tar.gz")
    ),
    "hermes-source.tar.gz": await archive(
      hermesRoot,
      source.hermesHashes,
      join(directory, "hermes-source.tar.gz")
    ),
  };
  await jsonFile(join(directory, "source-archives.json"), result);
  return result;
}

function assertLimits(): void {
  same(
    FILE_BUDGET,
    {
      maxGeneratedTokens: comparisonLimits.generatedTokens,
      maxOutputTokens: comparisonLimits.perResponseTokens,
      maxProviderRequests: comparisonLimits.providerRequests,
      timeoutMs: comparisonLimits.timeoutMs,
    },
    "File budget versus authoritative proxy"
  );
}

/** Explicit action only. Importing or running tests does not freeze or make provider calls. */
export async function freezeFileStudy(studyRoot = defaultRoot): Promise<void> {
  assertLimits();
  const root = await privateDirectory(studyRoot);
  const directory = join(root, "frozen");
  await mkdir(directory);
  const source = await snapshot();
  const runtime = await runtimeFingerprint();
  const codeSandboxPolicySha256 = await policyHash();
  const candidateContractSha256 = await policyHash("--contract-sha256");
  const schedules: Record<Split, string> = {
    confirmatory: "",
    development: "",
  };
  for (const phase of ["development", "confirmatory"] as const) {
    const plan = buildFileSchedule(phase);
    schedules[phase] = sha256(JSON.stringify(plan));
    await jsonFile(join(directory, `${phase}-schedule.json`), plan);
  }
  await writeFile(
    join(directory, "protocol.md"),
    await readFile(join(repository, protocolPath)),
    { flag: "wx" }
  );
  const manifest: FrozenManifest = {
    ...source,
    archives: await archiveSnapshot(directory, source),
    budget: FILE_BUDGET,
    candidateContractSha256,
    codeSandboxPolicySha256,
    endpoint: upstreamEndpoint,
    model: comparisonModel,
    runtimeFingerprint: runtime,
    schedules,
  };
  await jsonFile(join(directory, "environment.json"), {
    bun: Bun.version,
    familyWeights: "equal",
    frozenAt: new Date().toISOString(),
    hermesPython,
    modelMetadata: modelMetadata(),
    normalization: {
      maxTokens: 4096,
      reasoning: "Optional reasoning/thinking fields omitted upstream",
      streaming: false,
      temperature: 0.2,
    },
    preparedPython: filePython,
    repetitions: { confirmatory: 2, development: 1 },
    shuffleSeed: fileShuffleSeed,
  });
  same(await snapshot(), source, "Source during freeze");
  await jsonFile(join(directory, "manifest.json"), manifest);
  process.stdout.write(
    `${JSON.stringify({ confirmatoryPairs: 54, developmentPairs: 18, directory, event: "native-file-frozen" })}\n`
  );
}

async function readPlan(
  root: string,
  phase: Phase,
  offlineScripted: boolean
): Promise<{
  manifest: FrozenManifest | null;
  manifestSha256: string | null;
  schedule: FileSchedulePair[];
}> {
  if (phase === "pilot") {
    const schedule: FileSchedulePair[] = [
      {
        family: "xlsx_reconciliation",
        order: ["atlas", "hermes"],
        pairId: "native-file-pilot-xlsx-v999",
        repetition: 0,
        split: "development",
        variant: 999,
      },
      {
        family: "csv_join",
        order: ["hermes", "atlas"],
        pairId: "native-file-pilot-csv-v999",
        repetition: 0,
        split: "development",
        variant: 999,
      },
    ];
    if (offlineScripted) {
      return { manifest: null, manifestSha256: null, schedule };
    }
    // Live transport pilots are unscored, but must verify the same immutable
    // admission as scored work. Only explicitly injected fake transport bypasses.
    const frozen = await readPlan(root, "development", false);
    return { ...frozen, schedule };
  }
  const raw = await readFile(join(root, "frozen/manifest.json"));
  const manifest = JSON.parse(raw.toString()) as FrozenManifest;
  const schedule = JSON.parse(
    await readFile(join(root, `frozen/${phase}-schedule.json`), "utf8")
  ) as FileSchedulePair[];
  same(
    sha256(JSON.stringify(schedule)),
    manifest.schedules[phase],
    "Frozen schedule hash"
  );
  same(schedule, buildFileSchedule(phase), "Frozen schedule definitions");
  same(manifest.budget, FILE_BUDGET, "Frozen budget");
  if (
    manifest.model !== comparisonModel ||
    manifest.endpoint !== upstreamEndpoint
  ) {
    throw new Error("Frozen provider/model changed.");
  }
  for (const [name, hash] of Object.entries(manifest.archives)) {
    same(
      sha256(await readFile(join(root, "frozen", name))),
      hash,
      `Archive ${name}`
    );
  }
  return { manifest, manifestSha256: sha256(raw), schedule };
}

async function treeHashes(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Source/snapshot symlinks are forbidden.");
      }
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        if ((await stat(path)).size > 20_000_000) {
          throw new Error("Source file exceeds inspection limit.");
        }
        entries[relative(root, path)] = sha256(await readFile(path));
      } else {
        throw new Error("Special files are forbidden in fixture sources.");
      }
    }
  }
  await walk(root);
  return entries;
}

async function makeReadOnly(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(path);
    } else {
      await chmod(path, 0o444);
    }
  }
  await chmod(root, 0o555);
}

/** Generate once per pair. Both adapters receive this exact source directory. */
export async function prepareFilePair(
  directory: string,
  pair: FileSchedulePair
) {
  await mkdir(directory, { recursive: true });
  const originals = join(directory, "source-originals");
  const manifestPath = join(directory, "private-oracle.json");
  const result = await command([
    filePython,
    join(repository, "scripts/harness-native-mimo-v1/file-fixtures.py"),
    pair.family,
    pair.split === "confirmatory" ? "holdout" : "development",
    String(pair.variant),
    originals,
    manifestPath,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Fixture preparation failed: ${result.stderr}`);
  }
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as Omit<FileTask, "seed">;
  // Python's 64-bit seed exceeds JS safe integers; derive its exact decimal form
  // from the frozen task-ID rule and retain the original manifest bytes intact.
  const seed = BigInt(`0x${sha256(parsed.id).slice(0, 16)}`).toString();
  const task: FileTask = { ...parsed, seed };
  const hashes = await treeHashes(originals);
  same(
    hashes,
    Object.fromEntries(
      Object.entries(task.sources).sort(([a], [b]) => a.localeCompare(b))
    ),
    "Generated source hashes"
  );
  await chmod(manifestPath, 0o444);
  await makeReadOnly(originals);
  const prompt = `${task.prompt}\nShared prepared environment: Python ${filePython} is available with pandas, openpyxl, python-docx, python-pptx, pypdf, reportlab and Pillow. Do not install packages. Work only in this task's workspace; preserve source files unless the task explicitly requests a source edit. Deliver one clearly identified finished file.`;
  const metadata = {
    manifestSha256: sha256(raw),
    originals,
    seed,
    sourceHashes: hashes,
    taskId: task.id,
    taskTurns: [prompt],
  };
  await jsonFile(join(directory, "pair-input.json"), metadata);
  return { ...metadata, manifestPath, task };
}

function canonicalDelivery(raw: string, workspace: string): string | null {
  let path = raw.trim();
  try {
    if (path.startsWith("file://")) {
      path = decodeURIComponent(new URL(path).pathname);
    } else {
      path = decodeURIComponent(path);
    }
  } catch {
    return null;
  }
  if (path.includes("\\") || path.includes("\0") || /^[a-z]+:/i.test(path)) {
    return null;
  }
  const absolute = resolve(workspace, path);
  if (!inside(workspace, absolute)) {
    return null;
  }
  const normalized = relative(workspace, absolute).split(sep).join("/");
  return normalized.startsWith("artifacts/") &&
    posix.basename(normalized) !== "artifacts"
    ? normalized
    : null;
}

export interface DeliverySelection {
  candidates: string[];
  evidence:
    | "final-text"
    | "native-published-artifact"
    | "fixed-code-target"
    | "unresolved";
  invalidCandidates: string[];
  path: string | null;
}

/** No filesystem search or semantic oracle is consulted during path selection. */
export function selectFileDelivery(
  observation: Pick<
    NativeObservation,
    "finalText" | "artifacts" | "workspaceRoot"
  >,
  kind: string
): DeliverySelection {
  if (kind === "code_fix") {
    return {
      candidates: ["app/money.py"],
      evidence: "fixed-code-target",
      invalidCandidates: [],
      path: "app/money.py",
    };
  }
  const workspace = observation.workspaceRoot;
  if (!workspace) {
    return {
      candidates: [],
      evidence: "unresolved",
      invalidCandidates: [],
      path: null,
    };
  }
  const candidates = new Set<string>();
  const invalid = new Set<string>();
  const consider = (raw: string) => {
    if (!raw.includes("artifacts/")) {
      return;
    }
    const path = canonicalDelivery(raw, workspace);
    if (path) {
      candidates.add(path);
    } else {
      invalid.add(raw);
    }
  };
  let remainder = observation.finalText.replace(
    markdownLink,
    (_match, enclosed: string | undefined, plain: string | undefined) => {
      consider(enclosed ?? plain ?? "");
      return " ";
    }
  );
  remainder = remainder.replace(inlineCode, (_match, code: string) => {
    consider(code);
    return " ";
  });
  for (const token of remainder.split(/\s+/)) {
    consider(
      token.replace(leadingPunctuation, "").replace(trailingPunctuation, "")
    );
  }
  if (candidates.size || invalid.size) {
    return {
      candidates: [...candidates],
      evidence: "final-text",
      invalidCandidates: [...invalid],
      path:
        candidates.size === 1 && !invalid.size
          ? ([...candidates][0] ?? null)
          : null,
    };
  }
  for (const item of observation.artifacts ?? []) {
    if (object(item.native) && typeof item.native.path === "string") {
      consider(item.native.path);
    }
  }
  return {
    candidates: [...candidates],
    evidence: candidates.size ? "native-published-artifact" : "unresolved",
    invalidCandidates: [...invalid],
    path:
      candidates.size === 1 && !invalid.size
        ? ([...candidates][0] ?? null)
        : null,
  };
}

async function runAdapter(
  input: FileAtlasRequest,
  harness: Harness,
  directory: string,
  nativeRoot: string,
  deadlineAt: number
) {
  await jsonFile(join(directory, "runner-input.json"), input);
  const stdout = await open(join(directory, "runner-stdout.json"), "wx");
  const stderr = await open(join(directory, "runner-stderr.log"), "wx");
  const args =
    harness === "atlas"
      ? [
          process.execPath,
          join(
            repository,
            "scripts/harness-native-mimo-v1/file-atlas-runner.ts"
          ),
        ]
      : [
          hermesPython,
          join(
            repository,
            "scripts/harness-native-mimo-v1/file_hermes_runner.py"
          ),
        ];
  let timedOut = false;
  let invocationError: string | null = null;
  let exitCode = -1;
  const started = Date.now();
  try {
    const child = spawn(args[0]!, args.slice(1), {
      cwd: nativeRoot,
      detached: true,
      env: {
        NO_COLOR: "1",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONDONTWRITEBYTECODE: "1",
        TMPDIR: "/private/tmp",
      },
      stdio: ["pipe", stdout.fd, stderr.fd],
    });
    const terminate = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      }
    };
    const remaining = Math.max(1, deadlineAt - Date.now());
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
    }, remaining);
    const hardTimeout = setTimeout(
      () => terminate("SIGKILL"),
      remaining + 2000
    );
    try {
      const closed = new Promise<number>((accept) => {
        child.once("error", (error) => {
          invocationError = errorText(error);
          accept(-1);
        });
        child.once("close", (code) => accept(code ?? -1));
      });
      child.stdin?.on("error", (error) => {
        invocationError = errorText(error);
      });
      child.stdin?.end(JSON.stringify(input));
      exitCode = await closed;
    } finally {
      clearTimeout(timeout);
      clearTimeout(hardTimeout);
      terminate("SIGKILL");
    }
  } catch (error) {
    invocationError = errorText(error);
  } finally {
    await stdout.close();
    await stderr.close();
  }
  let result: NativeObservation = {
    finalText: "",
    framework: harness,
    nativeEvents: [],
    sessions: [],
    status: "failed",
  };
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(directory, "runner-stdout.json"), "utf8")
    );
    if (
      !(
        object(raw) &&
        raw.framework === harness &&
        typeof raw.finalText === "string" &&
        Array.isArray(raw.sessions) &&
        Array.isArray(raw.nativeEvents)
      )
    ) {
      throw new Error("Invalid native observation shape.");
    }
    result = raw as unknown as NativeObservation;
  } catch (error) {
    invocationError ??= errorText(error);
  }
  if (result.workspaceRoot) {
    const actual = await realpath(result.workspaceRoot);
    if (!inside(nativeRoot, actual)) {
      throw new Error(
        "Adapter workspace escaped its assigned private native root."
      );
    }
    result.workspaceRoot = actual;
  }
  return {
    elapsedMs: Date.now() - started,
    exitCode,
    invocationError,
    result,
    timedOut,
  };
}

function usage(run?: ComparisonRun, evidence?: ProductUsageEvidence) {
  return run
    ? {
        budgetExceeded: run.budgetExceeded,
        cachedTokens: evidence?.cachedTokens ?? null,
        costUsd: null,
        generatedTokens: evidence?.generatedTokens ?? null,
        mandatoryUsageKnown: evidence?.mandatoryUsageKnown ?? false,
        missingUsage: !(evidence?.mandatoryUsageKnown ?? false),
        observedGeneratedTokens:
          evidence?.observedGeneratedTokens ?? run.generatedTokens,
        observedPromptTokens:
          evidence?.observedPromptTokens ?? run.promptTokens,
        promptTokens: evidence?.promptTokens ?? null,
        providerRequests: run.providerRequests,
      }
    : null;
}

export async function bindSelectedArtifact(
  observation: NativeObservation,
  selection: DeliverySelection
) {
  const base = {
    nativeEffectObserved: false,
    pass: false,
    snapshotMatches: false,
  };
  if (!(selection.path && observation.workspaceRoot)) {
    return base;
  }
  try {
    const root = await realpath(observation.workspaceRoot);
    const path = join(root, selection.path);
    let ancestor = path;
    while (ancestor !== root) {
      if ((await lstat(ancestor)).isSymbolicLink()) {
        throw new Error("Selected artifact has a symlink component.");
      }
      ancestor = dirname(ancestor);
      if (!inside(root, ancestor)) {
        throw new Error("Selected artifact escaped workspace.");
      }
    }
    const info = await stat(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 20_000_000) {
      throw new Error(
        "Selected artifact is not a bounded, independent regular file."
      );
    }
    const actualSha256 = sha256(await readFile(path));
    const snapshots = (observation.workspaceFiles ?? []).filter(
      (entry) => object(entry) && entry.path === selection.path
    );
    const snapshotMatches =
      snapshots.length === 1 &&
      object(snapshots[0]) &&
      snapshots[0].sha256 === actualSha256;
    const nativeEffectObserved = observation.nativeEvents.some((entry) => {
      if (
        !object(entry) ||
        typeof entry.name !== "string" ||
        !effectTools.has(entry.name)
      ) {
        return false;
      }
      let value = entry.result;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          return false;
        }
      }
      return (
        object(value) &&
        !(
          value.error ||
          value.success === false ||
          value.isError === true ||
          (typeof value.exitCode === "number" && value.exitCode !== 0) ||
          (typeof value.exit_code === "number" && value.exit_code !== 0)
        )
      );
    });
    return {
      actualSha256,
      bytes: info.size,
      nativeEffectObserved,
      pass: snapshotMatches && nativeEffectObserved,
      snapshotMatches,
    };
  } catch (error) {
    return { ...base, error: errorText(error) };
  }
}

async function grade(
  directory: string,
  pair: Awaited<ReturnType<typeof prepareFilePair>>,
  observation: NativeObservation,
  expectedPolicyHash: string,
  expectedContractHash: string,
  inspectionAllowed: boolean
) {
  const started = Date.now();
  const selection: DeliverySelection = inspectionAllowed
    ? selectFileDelivery(observation, pair.task.kind)
    : {
        candidates: [],
        evidence: "unresolved",
        invalidCandidates: [],
        path: null,
      };
  await jsonFile(join(directory, "delivery-selection.json"), selection); // Irrevocably selected before any oracle call.
  if (!inspectionAllowed) {
    return {
      error:
        "Native process cleanup is not sufficient for artifact inspection.",
      gradingMs: Date.now() - started,
      oracle: null,
      selection,
      success: false,
    };
  }
  if (!observation.workspaceRoot) {
    return {
      error: "Missing native workspace.",
      gradingMs: Date.now() - started,
      oracle: null,
      selection,
      success: false,
    };
  }
  const binding = await bindSelectedArtifact(observation, selection);
  await jsonFile(join(directory, "delivery-binding.json"), binding);
  if (!binding.pass) {
    return {
      binding,
      error:
        "Selected artifact was not bound to unchanged native bytes and a native effect receipt.",
      gradingMs: Date.now() - started,
      oracle: null,
      selection,
      success: false,
    };
  }
  const args = [
    filePython,
    join(repository, "scripts/harness-native-mimo-v1/file-oracles.py"),
    pair.manifestPath,
    observation.workspaceRoot,
    pair.originals,
  ];
  if (selection.path) {
    args.push("--delivered-path", selection.path);
  }
  let codeEvidence: unknown = null;
  if (pair.task.kind === "code_fix") {
    const path = join(directory, "hidden-code-receipt.json");
    const grading = await command(
      [
        filePython,
        join(repository, "scripts/harness-native-mimo-v1/file-code-check.py"),
        join(observation.workspaceRoot, "app/money.py"),
        pair.manifestPath,
        path,
      ],
      { timeoutMs: 35_000 }
    );
    await jsonFile(join(directory, "hidden-code-executor.json"), grading);
    if (grading.exitCode === 0) {
      codeEvidence = JSON.parse(await readFile(path, "utf8"));
      args.push(
        "--hidden-code",
        path,
        "--sandbox-policy-sha256",
        expectedPolicyHash,
        "--candidate-contract-sha256",
        expectedContractHash
      );
    }
  }
  const oracle = await trustedJsonCommand(args, 60_000);
  await jsonFile(join(directory, "artifact-oracle.json"), oracle);
  return {
    binding,
    codeEvidence,
    gradingMs: Date.now() - started,
    oracle,
    selection,
    success: selection.path !== null && object(oracle) && oracle.pass === true,
  };
}

interface BatchOptions {
  candidateLabel?: string;
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  keyFile?: string;
  phase: Phase;
  studyRoot?: string;
}

async function attempt(
  options: BatchOptions,
  context: {
    batch: string;
    directory: string;
    harness: Harness;
    keyFile: string;
    nativeParent: string;
    pair: FileSchedulePair;
    prepared: Awaited<ReturnType<typeof prepareFilePair>> | null;
    preparationError?: string;
    source: Snapshot;
    expectedPolicyHash: string;
    expectedContractHash: string;
  }
) {
  const id = `${context.batch}-${context.pair.pairId}-${context.harness}`;
  if (!safeId.test(id)) {
    throw new Error("Unsafe trial identifier.");
  }
  const directory = join(context.directory, "trials", id);
  const { identity, identitySha256 } = await createProductRuntimeIdentity({
    attemptId: id,
    harness: context.harness,
    nativeParent: context.nativeParent,
    pairId: context.pair.pairId,
    repetition: context.pair.repetition,
    taskId: context.prepared?.task.id,
    trialDirectory: directory,
  });
  const started = Date.now();
  const start = {
    at: new Date(started).toISOString(),
    candidateSourceHash: context.source.candidateSourceHash,
    event: "start",
    family: context.pair.family,
    harness: context.harness,
    id,
    identitySha256,
    pairId: context.pair.pairId,
    phase: options.phase,
    repetition: context.pair.repetition,
    transportId: identity.transportId,
    variant: context.pair.variant,
  };
  await ledger(context.directory, start);
  let proxy: Awaited<ReturnType<typeof startProductProxy>> | undefined;
  let proxyClosed = false;
  let ended = false;
  try {
    const prepared = context.prepared;
    if (!prepared) {
      throw new Error(
        context.preparationError ?? "Fixture preparation unavailable."
      );
    }
    await mkdir(directory, { recursive: true });
    const nativeRoot = identity.nativeStateRoot;
    proxy = await startProductProxy({
      directory: join(directory, "wire"),
      fetchUpstream: options.fetchUpstream,
      harness: context.harness,
      keyFile: context.keyFile,
      runId: identity.transportId,
    });
    const input: FileAtlasRequest = {
      budget: { ...FILE_BUDGET },
      model: comparisonModel,
      modelMetadata: modelMetadata(),
      proxyBaseUrl: proxy.url,
      pythonPath: filePython,
      runId: identity.transportId,
      sourceDirectory: prepared.originals,
      stateRoot: nativeRoot,
      taskTurns: prepared.taskTurns,
    };
    const execution = await runAdapter(
      input,
      context.harness,
      directory,
      nativeRoot,
      proxy.run.startedAt + FILE_BUDGET.timeoutMs
    );
    const usageEvidence = await proxy.finalize(); // Model access and owned adapter processes end before private grading.
    proxyClosed = true;
    const measured = proxy.run;
    if (
      execution.timedOut ||
      execution.elapsedMs > FILE_BUDGET.timeoutMs ||
      measured.generatedTokens > FILE_BUDGET.maxGeneratedTokens ||
      measured.providerRequests > FILE_BUDGET.maxProviderRequests
    ) {
      measured.budgetExceeded = true;
    }
    const status = usageEvidence.mandatoryUsageKnown
      ? measured.budgetExceeded
        ? "budget_exceeded"
        : execution.exitCode === 0 && !execution.invocationError
          ? execution.result.status
          : "failed"
      : "accounting_uncertain";
    const observed = { ...execution.result, status };
    const sourceCopies = Object.fromEntries(
      (observed.sourceCopies ?? [])
        .map((file) => [file.path, file.sha256])
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
    );
    const inputIdentical =
      JSON.stringify(sourceCopies) === JSON.stringify(prepared.sourceHashes);
    const session = observed.sessions[0];
    const boundaryValid =
      observed.sessions.length === 1 &&
      session?.initialHistoryCount === 0 &&
      session.turns.length === prepared.taskTurns.length &&
      session.turns.every(
        (turn, index) =>
          turn.input === prepared.taskTurns[index] &&
          turn.status === "completed"
      );
    const inspectionAllowed =
      context.harness === "hermes"
        ? observed.evidence?.artifactInspectionAllowed === true
        : execution.exitCode === 0 &&
          !execution.timedOut &&
          status === "completed";
    const evaluation = await grade(
      directory,
      prepared,
      observed,
      context.expectedPolicyHash,
      context.expectedContractHash,
      inspectionAllowed
    );
    const result = {
      ...start,
      at: new Date().toISOString(),
      boundaryValid,
      elapsedMs: execution.elapsedMs,
      evaluation,
      event: "end",
      exitCode: execution.exitCode,
      infrastructureError: execution.invocationError,
      inputIdentical,
      manifestSha256: prepared.manifestSha256,
      nativeRoot,
      providerStatuses: measured.providerStatuses,
      seed: prepared.seed,
      status,
      success:
        status === "completed" &&
        inputIdentical &&
        boundaryValid &&
        evaluation.success,
      taskId: prepared.task.id,
      totalAttemptElapsedMs: Date.now() - started,
      transportAdmitted: measured.providerRequests > 0,
      usage: usage(measured, usageEvidence),
      usageEvidence,
    };
    await jsonFile(join(directory, "observation.json"), observed);
    await jsonFile(join(directory, "result.json"), result);
    await ledger(context.directory, result);
    ended = true;
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (ended) {
      throw error;
    }
    const infrastructureError = errorText(error);
    if (proxy && !proxyClosed) {
      try {
        await proxy.finalize();
        proxyClosed = true;
      } catch (finalizationError) {
        await ledger(context.directory, {
          ...start,
          event: "error",
          infrastructureError: errorText(finalizationError),
          stage: "usage-finalization",
        });
      }
    }
    await ledger(context.directory, {
      ...start,
      at: new Date().toISOString(),
      event: "error",
      infrastructureError,
    });
    const end = {
      ...start,
      at: new Date().toISOString(),
      event: "end",
      infrastructureError,
      providerStatuses: proxy?.run.providerStatuses ?? [],
      status: "failed",
      success: false,
      totalAttemptElapsedMs: Date.now() - started,
      transportAdmitted: (proxy?.run.providerRequests ?? 0) > 0,
      usage: usage(proxy?.run, proxy?.usageEvidence),
      usageEvidence: proxy?.usageEvidence ?? null,
    };
    await ledger(context.directory, end);
    process.stdout.write(`${JSON.stringify(end)}\n`);
  } finally {
    try {
      if (!proxyClosed) {
        await proxy?.close();
      }
    } catch (error) {
      await ledger(context.directory, {
        ...start,
        at: new Date().toISOString(),
        event: "error",
        infrastructureError: errorText(error),
        stage: "proxy-close",
      });
    }
  }
}

/** Complete schedules only; no filters, adaptive retries, automatic freeze or implicit provider run. */
export async function runFileBatch(options: BatchOptions): Promise<string> {
  assertLimits();
  if (options.fetchUpstream && options.phase !== "pilot") {
    throw new Error("Scripted transport is only allowed for unscored pilots.");
  }
  const root = await privateDirectory(options.studyRoot ?? defaultRoot);
  const plan = await readPlan(
    root,
    options.phase,
    Boolean(options.fetchUpstream)
  );
  const source = await snapshot();
  const runtime = await runtimeFingerprint();
  const expectedPolicyHash = await policyHash();
  const candidateContractSha256 = await policyHash("--contract-sha256");
  if (plan.manifest) {
    same(
      source.controlHashes,
      plan.manifest.controlHashes,
      "Frozen file protocol"
    );
    same(
      source.hermesHashes,
      plan.manifest.hermesHashes,
      "Pinned Hermes source"
    );
    same(runtime, plan.manifest.runtimeFingerprint, "Prepared runtime");
    same(
      expectedPolicyHash,
      plan.manifest.codeSandboxPolicySha256,
      "Code sandbox policy"
    );
    same(
      candidateContractSha256,
      plan.manifest.candidateContractSha256,
      "Disclosed code API contract"
    );
  }
  const batch = `${options.phase}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = await privateDirectory(join(root, "batches", batch));
  const nativeParent = await privateDirectory(
    await mkdtemp("/private/tmp/agent-runtime-")
  );
  if (options.phase !== "pilot" || !options.fetchUpstream) {
    const admissions = await privateDirectory(join(root, "admissions"));
    const name =
      options.phase === "pilot"
        ? `live-pilot-${source.candidateSourceHash}`
        : options.phase === "confirmatory"
          ? "confirmatory"
          : `development-${source.candidateSourceHash}`;
    await jsonFile(join(admissions, `${name}.json`), {
      admittedAt: new Date().toISOString(),
      batch,
      candidateSourceHash: source.candidateSourceHash,
    });
  }
  const keyFile = resolve(
    options.keyFile ?? join(evaluationRoot, "credential")
  );
  await jsonFile(join(directory, "batch.json"), {
    batch,
    candidateLabel:
      options.candidateLabel ?? source.candidateSourceHash.slice(0, 12),
    phase: options.phase,
    schedule: plan.schedule,
    scored: options.phase !== "pilot",
    transportMode: options.fetchUpstream ? "offline-scripted" : "live",
    ...source,
    budget: FILE_BUDGET,
    candidateContractSha256,
    expectedPolicyHash,
    manifestSha256: plan.manifestSha256,
    model: comparisonModel,
    runtimeFingerprint: runtime,
  });
  process.stdout.write(
    `${JSON.stringify({ directory, event: "native-file-batch-start", pairs: plan.schedule.length, phase: options.phase })}\n`
  );
  try {
    await archiveSnapshot(directory, source);
    for (const pair of plan.schedule) {
      same(await snapshot(), source, "Candidate/protocol before paired trial");
      let prepared: Awaited<ReturnType<typeof prepareFilePair>> | null = null;
      let preparationError: string | undefined;
      try {
        prepared = await prepareFilePair(
          join(directory, "pairs", pair.pairId),
          pair
        );
        if (prepared.task.kind === "code_fix") {
          same(
            prepared.task.candidateContractSha256,
            candidateContractSha256,
            "Fixture/code-grader API contract"
          );
        }
      } catch (error) {
        preparationError = errorText(error);
        await ledger(directory, {
          at: new Date().toISOString(),
          error: preparationError,
          event: "pair-preparation-error",
          pairId: pair.pairId,
        });
      }
      for (const harness of pair.order) {
        await attempt(options, {
          batch,
          directory,
          expectedContractHash: candidateContractSha256,
          expectedPolicyHash,
          harness,
          keyFile,
          nativeParent,
          pair,
          preparationError,
          prepared,
          source,
        });
      }
      if (prepared) {
        same(
          await treeHashes(prepared.originals),
          prepared.sourceHashes,
          "Immutable paired source bytes"
        );
        same(
          sha256(await readFile(prepared.manifestPath)),
          prepared.manifestSha256,
          "Private expectation manifest"
        );
      }
      same(await snapshot(), source, "Candidate/protocol after paired trial");
    }
    same(await runtimeFingerprint(), runtime, "Prepared runtime during batch");
    if (plan.manifestSha256) {
      same(
        sha256(await readFile(join(root, "frozen/manifest.json"))),
        plan.manifestSha256,
        "Frozen manifest during batch"
      );
    }
    const runtimeIdentitiesSha256 =
      await finalizeProductRuntimeIdentities(directory);
    await jsonFile(join(directory, "completed.json"), {
      at: new Date().toISOString(),
      pairedTasks: plan.schedule.length,
      runtimeIdentitiesSha256,
      scheduledAttempts: plan.schedule.length * 2,
      sourceUnchanged: true,
    });
  } catch (error) {
    await ledger(directory, {
      at: new Date().toISOString(),
      error: errorText(error),
      event: "batch-error",
    });
    await jsonFile(join(directory, "interrupted.json"), {
      at: new Date().toISOString(),
      error: errorText(error),
    });
    throw error;
  }
  return directory;
}

if (import.meta.main) {
  const [mode, ...arguments_] = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !(
        name &&
        value &&
        ["--study-root", "--key-file", "--candidate-label"].includes(name)
      ) ||
      flags.has(name)
    ) {
      throw new Error(
        "Use freeze|pilot|development|confirmatory with --study-root, --key-file or --candidate-label value pairs."
      );
    }
    flags.set(name, value);
  }
  if (mode === "freeze") {
    await freezeFileStudy(flags.get("--study-root"));
  } else if (
    mode === "pilot" ||
    mode === "development" ||
    mode === "confirmatory"
  ) {
    await runFileBatch({
      candidateLabel: flags.get("--candidate-label"),
      keyFile: flags.get("--key-file"),
      phase: mode,
      studyRoot: flags.get("--study-root"),
    });
  } else {
    throw new Error(
      "Usage: bun scripts/harness-native-mimo-v1/file-run.ts freeze|pilot|development|confirmatory"
    );
  }
}
