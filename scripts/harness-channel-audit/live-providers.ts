import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createAgentHarness } from "@atlas/agent";
import {
  getProfileSoulDir,
  getUserConfigDir,
  type ProviderInstance,
  runWithUserConfigDir,
  type UserConfig,
} from "@atlas/core";
import { createSqliteDatabase } from "@atlas/db";
import { createProviderForInstance } from "../../apps/server/src/providers/create";
import { getChatgptRuntime } from "../../apps/server/src/providers/subscription/runtimes";
import { AgentService } from "../../apps/server/src/services/agent-service";
import {
  decodeStoredModelSelection,
  resolveDefaultModelForInstance,
} from "../../apps/server/src/services/provider-instance-helpers";
import { withMswCassette } from "../../apps/server/src/testing/llm-msw-cassette";
import {
  readFileTool,
  writeFileTool,
} from "../../packages/core/src/tools/builtin";
import { buildToolExecutionContext } from "../../packages/core/src/tools/context";

// Explicit live gate: only synthetic prompts/files leave the machine. Read the
// configured credentials in memory through read-only SQLite; never copy them
// into evidence, a fixture, or the disposable database on disk.
const sourceRoot = getUserConfigDir();
process.env.ATLAS_CONFIG_DIR = sourceRoot;
function requireEvidenceRoot(): string {
  const directory = process.env.ATLAS_LIVE_PROVIDER_EVIDENCE?.trim();
  assert.ok(directory && isAbsolute(directory));
  return directory;
}
const evidenceRoot = requireEvidenceRoot();
await mkdir(evidenceRoot, { recursive: true });
const source = new Database(join(sourceRoot, "data/sqlite/atlas.sqlite"), {
  readonly: true,
});
const cases: Array<{
  instance: ProviderInstance;
  model: string;
  reason: string[];
}> = [];
try {
  const rows = source
    .query("SELECT org_id, config FROM org_ai_configs")
    .all() as Array<{ org_id: string; config: string }>;
  for (const row of rows) {
    const config = JSON.parse(row.config) as UserConfig;
    const selections = (
      source
        .query("SELECT model FROM profiles WHERE org_id = ?")
        .all(row.org_id) as Array<{ model: string | null }>
    ).map((profile) => decodeStoredModelSelection(profile.model));
    for (const instance of config.providers) {
      const models = new Map<string, string[]>();
      const defaultModel = resolveDefaultModelForInstance(instance);
      if (defaultModel) {
        models.set(defaultModel, ["configured instance default"]);
      }
      for (const selection of selections) {
        if (selection?.providerId === instance.id) {
          models.set(selection.modelId, [
            ...(models.get(selection.modelId) ?? []),
            "selected by a profile",
          ]);
        }
      }
      for (const [model, reason] of models) {
        cases.push({ instance, model, reason });
      }
    }
  }
} finally {
  source.close();
}
assert.ok(
  cases.length > 0,
  "No configured provider/model cases were declared."
);
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const caseId = (item: (typeof cases)[number]) =>
  `${item.instance.type}-${sha256(`${item.instance.id}::${item.model}`).slice(0, 12)}`;
const manifest = cases.map((item) => ({
  id: caseId(item),
  instanceHash: sha256(item.instance.id).slice(0, 12),
  model: item.model,
  otherConfiguredModelsNotCovered:
    item.instance.customModels
      ?.map((model) => model.id)
      .filter(
        (model) =>
          !cases.some(
            (candidate) =>
              candidate.instance.id === item.instance.id &&
              candidate.model === model
          )
      ) ?? [],
  provider: item.instance.type,
  reasons: item.reason,
}));
await writeFile(
  join(evidenceRoot, "manifest.json"),
  JSON.stringify(
    {
      cases: manifest,
      observedAt: new Date().toISOString(),
      scope:
        "All configured instance defaults plus every profile-selected model; not every catalog model or provider/channel/role Cartesian combination.",
    },
    null,
    2
  )
);
console.log(JSON.stringify({ cases: manifest, event: "declared-manifest" }));

async function runCase(item: (typeof cases)[number], probe = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `atlas-${caseId(item)}-`))
  );
  try {
    return await runWithUserConfigDir(root, async () => {
      const sqlite = await createSqliteDatabase(":memory:");
      const db = sqlite.adapter;
      const orgId = "live_provider_org";
      const profileId = "live_provider_profile";
      const userId = "live_provider_user";
      const now = new Date().toISOString();
      const workspace = getProfileSoulDir(orgId, profileId);
      await mkdir(workspace, { recursive: true });
      const config: UserConfig = {
        defaultProviderId: item.instance.id,
        providers: [item.instance],
      };
      await db.upsertOrganization({
        createdAt: now,
        id: orgId,
        name: orgId,
        slug: orgId,
        updatedAt: now,
      });
      await db.createUser({
        createdAt: now,
        email: "synthetic@atlas.invalid",
        id: userId,
        name: "Synthetic operator",
        passwordHash: "unused",
        updatedAt: now,
      });
      await db.upsertOrgMember({
        createdAt: now,
        orgId,
        role: "member",
        userId,
      });
      await db.upsertOrgAiConfig({ config, orgId, updatedAt: now });
      await db.upsertProfile({
        createdAt: now,
        id: profileId,
        isDefault: true,
        isSuper: false,
        model: `${item.instance.id}::${item.model}`,
        name: "Synthetic verification",
        orgId,
        systemPrompt:
          "Execute the requested file verification using your assigned tools. Do not delegate.",
        updatedAt: now,
      });
      for (const name of ["write_file", "read_file"]) {
        await db.upsertTool({
          createdAt: now,
          description: name,
          handlerConfig: {},
          handlerType: "builtin",
          id: name,
          name,
          orgId,
          updatedAt: now,
        });
        await db.assignToolToProfile(profileId, name);
      }
      const service = new AgentService(null, null, db);
      let sessionId: string | undefined;
      try {
        const actor = {
          isPlatformAdmin: false,
          orgRole: "member" as const,
          userId,
        };
        sessionId = await service.createSession(
          orgId,
          "web",
          profileId,
          userId,
          actor
        );
        const provider = probe
          ? createProviderForInstance(item.instance, item.model)
          : null;
        const session =
          probe && provider
            ? createAgentHarness({
                provider,
                tools: [writeFileTool, readFileTool],
              }).createChatSession({
                toolContext: buildToolExecutionContext({
                  orgId,
                  orgRole: "member",
                  profileId,
                  userId,
                  workspaceRoot: workspace,
                }),
              })
            : await service.resolveSession(orgId, sessionId, actor);
        assert.ok(session);
        const nonce = `atlas-live-${crypto.randomUUID()}`;
        const prompt = `Use write_file to create artifacts/provider-proof.txt containing exactly ${nonce} (no newline). Then call read_file with the EXACT path returned by write_file. Return the content read from that file. You must execute both dependent tools; do not merely describe actions.`;
        const result = await session.send(prompt, {
          signal: AbortSignal.timeout(180_000),
        });
        const history = session.getHistory();
        await writeFile(
          join(
            evidenceRoot,
            `${caseId(item)}-${probe ? "probe" : "service"}-trace.json`
          ),
          JSON.stringify(history, null, 2)
        );
        const calls = history.flatMap((message) =>
          message.role === "assistant" ? (message.toolCalls ?? []) : []
        );
        const writeResult = history.find(
          (message) => message.role === "tool" && message.name === "write_file"
        );
        assert.ok(writeResult?.role === "tool", "No actual write_file result");
        const written = JSON.parse(writeResult.content);
        assert.equal(
          typeof written.path,
          "string",
          "write_file did not succeed"
        );
        const returnedPaths = [
          written.path,
          ...(written.artifacts ?? []).map(
            (artifact: { path: string }) => artifact.path
          ),
        ];
        const readCall = calls.find(
          (call) =>
            call.name === "read_file" &&
            returnedPaths.includes(call.arguments.path)
        );
        assert.ok(readCall, "No dependent read using the actual returned path");
        const readResult = history.find(
          (message) =>
            message.role === "tool" && message.toolCallId === readCall.id
        );
        assert.ok(readResult?.role === "tool");
        const read = JSON.parse(readResult.content);
        assert.equal(
          read.path,
          written.path,
          "Read must resolve to the actual file written"
        );
        assert.ok(history.indexOf(readResult) > history.indexOf(writeResult));
        assert.equal(read.content, nonce);
        assert.equal(read.truncated, false);
        const rel = relative(workspace, written.path);
        assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
        const bytes = await readFile(written.path);
        assert.equal(bytes.toString(), nonce);
        assert.ok(
          result.includes(nonce),
          "finalContentMatches: the final response did not contain the verified file content"
        );
        await db.upsertOrgMember({
          createdAt: now,
          orgId,
          role: "viewer",
          userId,
        });
        assert.equal(
          await service.resolveSession(orgId, sessionId, actor),
          null,
          "Stale member actor remained authorized after DB demotion"
        );
        return {
          bytes: bytes.length,
          calls: calls.map((call) => call.name),
          currentRoleRechecked: true,
          execution: probe
            ? "raw provider plus protected tools; separate service admission demotion check"
            : "AgentService with current DB tool authorization",
          fileSha256: sha256(bytes),
          status: "PASS",
        };
      } finally {
        if (sessionId) {
          await service.deleteSession(orgId, sessionId);
        }
        sqlite.close();
      }
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function recordCase(item: (typeof cases)[number], probe = false) {
  const captured = await withMswCassette(
    `live-${probe ? "probe" : "service"}-${caseId(item)}`,
    async () => {
      try {
        return { proof: await runCase(item, probe) };
      } catch (error) {
        return { error };
      }
    },
    {
      cassettesDir: join(evidenceRoot, "cassettes"),
      mode: "record",
      url: /.*/,
    }
  );
  // Preserve actual HTTP exchanges even when a later invariant fails. A saved
  // failed recording is evidence of failure, never a passing replay fixture.
  if ("error" in captured) {
    throw captured.error;
  }
  return captured.proof;
}

const results: unknown[] = [];
const only = process.env.ATLAS_LIVE_PROVIDER_CASE?.trim();
const selectedCases = cases.filter(
  (item) => !only || caseId(item) === only || item.instance.type === only
);
assert.ok(
  selectedCases.length > 0,
  "ATLAS_LIVE_PROVIDER_CASE did not match any declared provider/model case."
);
try {
  for (const item of selectedCases) {
    const startedAt = new Date().toISOString();
    const metadata = manifest.find((entry) => entry.id === caseId(item));
    try {
      let auth: unknown;
      if (item.instance.type === "chatgpt") {
        const runtime = getChatgptRuntime();
        const state = await runtime.getAuthState();
        assert.ok(
          state.authenticated,
          "Atlas ChatGPT runtime is not authenticated"
        );
        const models = await runtime.listModels();
        assert.ok(
          models.some((model) => model.id === item.model),
          "Selected model is not advertised by the authenticated runtime"
        );
        auth = {
          advertisedModel: item.model,
          authenticated: state.authenticated,
          runtimeVersion: state.runtimeVersion,
        };
      }
      let probeProof: unknown;
      if (
        process.env.ATLAS_LIVE_PROVIDER_PROBE === "1" &&
        item.instance.type !== "chatgpt" &&
        item.instance.type !== "claude"
      ) {
        probeProof = await recordCase(item, true);
        // A successful actual two-tool inference is evidence for this exact
        // instance/model only. Store it in the disposable configuration; the
        // operational configuration remains untouched and its original unknown
        // capability failure stays in the previous run's report.
        const entries = item.instance.customModels ?? [];
        const existing = entries.find((entry) => entry.id === item.model);
        item.instance = {
          ...item.instance,
          customModels: [
            ...entries.filter((entry) => entry.id !== item.model),
            {
              ...existing,
              capabilities: {
                ...existing?.capabilities,
                "chat.tool-use": {
                  source: "runtime-probe",
                  status: "supported",
                  verified: true,
                  verifiedAt: new Date().toISOString(),
                },
              },
              id: item.model,
            },
          ],
        };
      }
      const proof =
        item.instance.type === "chatgpt" || item.instance.type === "claude"
          ? await runCase(item)
          : await recordCase(item);
      const entry = {
        ...metadata,
        auth,
        capabilityScope: probeProof
          ? "Exact instance/model verified by this live tool probe; claim exists only in disposable config. Operational metadata was not changed."
          : "Configured metadata or native runtime guarantee; no probe capability claim was added.",
        finishedAt: new Date().toISOString(),
        operationalConfigurationChanged: false,
        probeProof,
        startedAt,
        ...proof,
      };
      results.push(entry);
      console.log(JSON.stringify(entry));
    } catch (error) {
      let reason = String(error);
      for (const secret of cases
        .map((candidate) => candidate.instance.apiKey)
        .filter(Boolean)) {
        reason = reason.replaceAll(secret, "[REDACTED]");
      }
      const entry = {
        ...metadata,
        finishedAt: new Date().toISOString(),
        reason,
        startedAt,
        status: "FAIL",
      };
      results.push(entry);
      console.log(JSON.stringify(entry));
      process.exitCode = 1;
    }
    await writeFile(
      join(evidenceRoot, "results.json"),
      JSON.stringify(results, null, 2)
    );
  }
} finally {
  getChatgptRuntime().close();
}
