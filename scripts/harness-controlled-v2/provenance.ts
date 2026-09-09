import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atlasSourceHashes,
  bootstrapSettings,
  harnessSourceHashes,
  hermesSourceHashes,
  sha256,
  shuffle,
  shuffleSeed,
} from "../harness-compare/provenance";
import {
  comparisonLimits,
  comparisonModel,
  upstreamEndpoint,
} from "../harness-compare/proxy";
import type { HarnessTask } from "../harness-compare/types";
import {
  buildControlledV2TaskSuite,
  CONTROLLED_V2_VERSION,
  verifyFrozenV1Dependencies,
} from "./tasks";

export type Phase = "pilot" | "development" | "confirmatory";
export type Harness = "atlas" | "hermes";
export interface Pair {
  order: Harness[];
  repetition: number;
  taskId: string;
}
export const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.."
);
export const hermesRoot = "/private/tmp/atlas-hermes-evaluation";
export const defaultStudyRoot = join(hermesRoot, "controlled-v2");
export const python = join(hermesRoot, "venv/bin/python");
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function jsonFile(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
}

export async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const actual = await realpath(path);
  if (!actual.startsWith(`/private/tmp${sep}`)) {
    throw new Error(
      "Controlled V2 evidence and private state must be under /private/tmp."
    );
  }
  await chmod(actual, 0o700);
  return actual;
}

export async function controlHashes(): Promise<Record<string, string>> {
  const hashes = await harnessSourceHashes(repository);
  for (const name of (
    await readdir(join(repository, "scripts/harness-controlled-v2"))
  ).sort()) {
    if (/\.(?:ts|py|json|md)$/.test(name)) {
      const path = `scripts/harness-controlled-v2/${name}`;
      hashes[path] = sha256(await readFile(join(repository, path)));
    }
  }
  const protocol = "docs/architecture/hermes-comparison-preregistration.md";
  hashes[protocol] = sha256(await readFile(join(repository, protocol)));
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))
  );
}

export function sameHashes(
  actual: Record<string, string>,
  expected: Record<string, string>,
  label: string
) {
  if (sha256(JSON.stringify(actual)) !== sha256(JSON.stringify(expected))) {
    throw new Error(`${label} changed (including additions/removals).`);
  }
}

export async function sourceSnapshot() {
  verifyFrozenV1Dependencies();
  const [atlasHashes, controls, hermesHashes] = await Promise.all([
    atlasSourceHashes(repository),
    controlHashes(),
    hermesSourceHashes(join(hermesRoot, "source")),
  ]);
  // Reuse the exact original pinned adapters, proxy, tools and oracle, never a mutable lookalike.
  const original = JSON.parse(
    await readFile(join(hermesRoot, "frozen-v1/manifest.json"), "utf8")
  );
  sameHashes(
    await harnessSourceHashes(repository),
    original.harnessHashes,
    "Original V1 harness dependencies"
  );
  sameHashes(
    hermesHashes,
    original.hermesHashes,
    "Original pinned Hermes source"
  );
  return {
    atlasHashes,
    candidateSourceHash: sha256(JSON.stringify(atlasHashes)),
    controlHashes: controls,
    hermesHashes,
  };
}
export type SourceSnapshot = Awaited<ReturnType<typeof sourceSnapshot>>;

async function archive(
  path: string,
  cwd: string,
  hashes: Record<string, string>
) {
  const child = Bun.spawn(["tar", "-czf", path, "--null", "-T", "-"], {
    cwd,
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  child.stdin.write(`${Object.keys(hashes).join("\0")}\0`);
  child.stdin.end();
  const stderr = await new Response(child.stderr).text();
  if (await child.exited) {
    throw new Error(`Source archive failed: ${stderr}`);
  }
  return sha256(await readFile(path));
}

export async function archiveSnapshot(
  directory: string,
  snapshot: SourceSnapshot
) {
  const archives: Record<string, string> = {};
  for (const [name, cwd, hashes] of [
    ["atlas-source.tar.gz", repository, snapshot.atlasHashes],
    ["control-source.tar.gz", repository, snapshot.controlHashes],
    ["hermes-source.tar.gz", join(hermesRoot, "source"), snapshot.hermesHashes],
  ] as const) {
    archives[name] = await archive(join(directory, name), cwd, hashes);
    if (
      !equalHashEntries(await archiveMembers(join(directory, name)), hashes)
    ) {
      throw new Error(`Archive members changed during capture: ${name}`);
    }
  }
  await jsonFile(join(directory, "archives.json"), archives);
  return archives;
}

/** Hash regular tar members without extracting or executing archived code. */
export async function archiveMembers(
  path: string
): Promise<Record<string, string>> {
  const program =
    "import hashlib,json,sys,tarfile\nresult={}\nwith tarfile.open(sys.argv[1], 'r:gz') as archive:\n for member in archive:\n  if not member.isfile() or member.name in result: raise ValueError('Nonregular or duplicate archive member')\n  stream=archive.extractfile(member)\n  result[member.name]=hashlib.file_digest(stream,'sha256').hexdigest()\nprint(json.dumps(result,sort_keys=True))\n";
  const child = Bun.spawn([python, "-I", "-c", program, path], {
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) {
    throw new Error(`Archive member verification failed: ${stderr}`);
  }
  return JSON.parse(stdout);
}

export function equalHashEntries(
  actual: Record<string, string>,
  expected: Record<string, string>
): boolean {
  const sorted = (map: Record<string, string>) =>
    Object.entries(map).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

export function pilotTask(): HarnessTask {
  const prompt =
    'Transport pilot: read input.txt, create artifacts/pilot.json containing exactly {"status":"READY"}, then finish with exactly {"status":"READY"}. The final chat may repeat these requested fields; include no additional artifact dump or prose. Preserve input.txt.';
  return {
    category: "file_transformation",
    expected: {
      artifacts: [
        {
          format: "json",
          path: "artifacts/pilot.json",
          value: { status: "READY" },
        },
      ],
      finalFacts: { status: "READY" },
      requiredReadPaths: ["input.txt"],
    },
    family: "transport-pilot",
    id: "controlled-v2-transport-pilot",
    initialFiles: { "input.txt": "READY\n" },
    prompt,
    seed: 0,
    split: "development",
    turns: [prompt],
  };
}

export function suite(phase: Phase): HarnessTask[] {
  return phase === "pilot"
    ? [pilotTask()]
    : buildControlledV2TaskSuite(
        phase === "confirmatory" ? "holdout" : "development"
      );
}
export function buildSchedule(
  tasks: readonly HarnessTask[],
  phase: Phase
): Pair[] {
  const result: Pair[] = [];
  for (
    let repetition = 0;
    repetition < (phase === "confirmatory" ? 2 : 1);
    repetition++
  ) {
    for (const [index, task] of shuffle(tasks, shuffleSeed).entries()) {
      result.push({
        order:
          (index + repetition) % 2 === 0
            ? ["atlas", "hermes"]
            : ["hermes", "atlas"],
        repetition,
        taskId: task.id,
      });
    }
  }
  return result;
}

export interface FrozenManifest extends SourceSnapshot {
  archives: Record<string, string>;
  bootstrapSettings: typeof bootstrapSettings;
  endpoint: string;
  limits: typeof comparisonLimits;
  model: string;
  protocolSha256: string;
  runtimeSha256?: string;
  scheduleHashes: Record<Phase, string>;
  taskHashes: Record<Phase, string>;
  version: string;
}

/** Explicit CLI action only. Tests and fake pilots do not freeze a real study. */
export async function freezeStudy(studyRoot = defaultStudyRoot) {
  const root = await privateDirectory(studyRoot);
  const directory = join(root, "frozen");
  await mkdir(directory, { mode: 0o700 }); // An existing or partial freeze is never overwritten.
  const snapshot = await sourceSnapshot();
  const tasks = {
    confirmatory: suite("confirmatory"),
    development: suite("development"),
    pilot: suite("pilot"),
  };
  const schedules = Object.fromEntries(
    Object.entries(tasks).map(([phase, values]) => [
      phase,
      buildSchedule(values, phase as Phase),
    ])
  ) as Record<Phase, Pair[]>;
  const protocol = await readFile(
    join(repository, "scripts/harness-controlled-v2/protocol.md")
  );
  for (const phase of ["pilot", "development", "confirmatory"] as const) {
    await jsonFile(join(directory, `${phase}-tasks.json`), tasks[phase]);
    await jsonFile(join(directory, `${phase}-schedule.json`), schedules[phase]);
  }
  await writeFile(join(directory, "protocol.md"), protocol, {
    flag: "wx",
    mode: 0o600,
  });
  const archives = await archiveSnapshot(directory, snapshot);
  const after = await sourceSnapshot();
  sameHashes(after.atlasHashes, snapshot.atlasHashes, "Atlas during freeze");
  sameHashes(
    after.controlHashes,
    snapshot.controlHashes,
    "Controls during freeze"
  );
  sameHashes(after.hermesHashes, snapshot.hermesHashes, "Hermes during freeze");
  const manifest: FrozenManifest = {
    ...snapshot,
    archives,
    bootstrapSettings,
    endpoint: upstreamEndpoint,
    limits: comparisonLimits,
    model: comparisonModel,
    protocolSha256: sha256(protocol),
    scheduleHashes: Object.fromEntries(
      Object.entries(schedules).map(([phase, values]) => [
        phase,
        sha256(JSON.stringify(values)),
      ])
    ) as Record<Phase, string>,
    taskHashes: Object.fromEntries(
      Object.entries(tasks).map(([phase, values]) => [
        phase,
        sha256(JSON.stringify(values)),
      ])
    ) as Record<Phase, string>,
    version: CONTROLLED_V2_VERSION,
  };
  await jsonFile(join(directory, "runtime.json"), {
    bunVersion: Bun.version,
    executable: process.execPath,
    hermes: JSON.parse(
      await readFile(join(hermesRoot, "setup-manifest.json"), "utf8")
    ),
    normalization: {
      maxTokensPerRequest: 4096,
      reasoning: "upstream default; no thinking/effort parameters",
      streaming: false,
      temperature: 0.2,
    },
    python,
    upstreamTimeoutMs: 90_000,
  });
  await jsonFile(join(directory, "manifest.json"), {
    ...manifest,
    frozenAt: new Date().toISOString(),
    runtimeSha256: sha256(await readFile(join(directory, "runtime.json"))),
  });
  return directory;
}

export async function loadPlan(root: string, phase: Phase, offline = false) {
  if (offline) {
    if (phase !== "pilot") {
      throw new Error(
        "Scripted transport is allowed only for unscored pilots."
      );
    }
    const tasks = suite("pilot");
    return {
      frozen: null,
      manifestPath: null,
      manifestSha256: null,
      schedule: buildSchedule(tasks, phase),
      tasks,
    };
  }
  const directory = join(root, "frozen");
  const manifestPath = join(directory, "manifest.json");
  const raw = await readFile(manifestPath);
  const frozen = JSON.parse(raw.toString()) as FrozenManifest;
  for (const name of [
    "atlas-source.tar.gz",
    "control-source.tar.gz",
    "hermes-source.tar.gz",
  ]) {
    const expected = frozen.archives[name];
    if (sha256(await readFile(join(directory, name))) !== expected) {
      throw new Error(`Frozen archive changed: ${name}`);
    }
    const members =
      name === "atlas-source.tar.gz"
        ? frozen.atlasHashes
        : name === "control-source.tar.gz"
          ? frozen.controlHashes
          : frozen.hermesHashes;
    if (
      !equalHashEntries(await archiveMembers(join(directory, name)), members)
    ) {
      throw new Error(`Frozen archive members changed: ${name}`);
    }
  }
  const tasks: HarnessTask[] = JSON.parse(
    await readFile(join(directory, `${phase}-tasks.json`), "utf8")
  );
  const schedule: Pair[] = JSON.parse(
    await readFile(join(directory, `${phase}-schedule.json`), "utf8")
  );
  if (
    frozen.version !== CONTROLLED_V2_VERSION ||
    frozen.model !== comparisonModel ||
    frozen.endpoint !== upstreamEndpoint ||
    JSON.stringify(frozen.limits) !== JSON.stringify(comparisonLimits) ||
    sha256(JSON.stringify(tasks)) !== frozen.taskHashes[phase] ||
    sha256(JSON.stringify(schedule)) !== frozen.scheduleHashes[phase] ||
    JSON.stringify(tasks) !== JSON.stringify(suite(phase)) ||
    JSON.stringify(schedule) !== JSON.stringify(buildSchedule(tasks, phase)) ||
    sha256(await readFile(join(directory, "protocol.md"))) !==
      frozen.protocolSha256 ||
    sha256(await readFile(join(directory, "runtime.json"))) !==
      frozen.runtimeSha256 ||
    JSON.stringify(frozen.bootstrapSettings) !==
      JSON.stringify(bootstrapSettings)
  ) {
    throw new Error("Frozen V2 task/schedule/protocol/model controls changed.");
  }
  return { frozen, manifestPath, manifestSha256: sha256(raw), schedule, tasks };
}
