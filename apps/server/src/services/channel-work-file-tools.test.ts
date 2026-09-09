import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildToolExecutionContext } from "@atlas/core";
import { getProfileArtifactsDir, getProfileSoulDir } from "@atlas/core/soul";
import { executeProtectedTool } from "@atlas/core/tools/execution";
import { setupTestConfigDir } from "../test-config-dir";
import { resolveExecutableToolsForPrincipal } from "./channel-guest-tool-policy";
import { channelWorkFileTools } from "./channel-work-file-tools";

setupTestConfigDir("atlas-channel-work-files-");
const orgId = "org_work_files";
const profileId = "profile_work_files";
const guestId = "user_channel_guest_work_files";

for (const channel of ["whatsapp", "telegram", "discord"]) {
  test(`${channel} supplies file tools without loading unrelated guest tools`, async () => {
    let loaded = false;
    const tools = await resolveExecutableToolsForPrincipal(
      guestId,
      async () => {
        loaded = true;
        throw new Error("Guest must not load profile tools, memory or MCP");
      },
      { channel }
    );
    expect(loaded).toBe(false);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "extract_document_text",
      "read_file",
      "spreadsheet",
      "write_docx",
      "write_file",
      "write_pptx",
    ]);
  });
}

test("guest tools can read and write work files but cannot access soul or symlink escapes", async () => {
  const context = buildToolExecutionContext({
    orgId,
    profileId,
    userId: guestId,
  });
  const root = getProfileSoulDir(orgId, profileId);
  const artifacts = getProfileArtifactsDir(orgId, profileId);
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(root, "MEMORY.md"), "private profile facts");
  await symlink(join(root, "MEMORY.md"), join(artifacts, "leak.txt"));
  const tools = channelWorkFileTools(true);
  const reader = tools.find((tool) => tool.name === "read_file")!;
  const writer = tools.find((tool) => tool.name === "write_file")!;
  await writer.run(
    { content: "Finished summary", path: "artifacts/summary.txt" },
    context
  );
  const read = await reader.run({ path: "artifacts/summary.txt" }, context);
  expect(JSON.stringify(read)).toContain("Finished summary");
  for (const filePath of [
    "MEMORY.md",
    "artifacts/../MEMORY.md",
    "artifacts/leak.txt",
  ]) {
    await expect(reader.run({ path: filePath }, context)).rejects.toThrow();
    await expect(
      writer.run({ content: "overwritten", path: filePath }, context)
    ).rejects.toThrow();
  }
  await expect(
    reader.run({ cwd: root, path: "MEMORY.md" }, context)
  ).rejects.toThrow();
  const extractor = tools.find(
    (tool) => tool.name === "extract_document_text"
  )!;
  await expect(
    extractor.run({ documentRef: "att_other_users_email" }, context)
  ).rejects.toThrow();
  const spreadsheet = tools.find((tool) => tool.name === "spreadsheet")!;
  await writeFile(join(root, "private.csv"), "secret,value\naccount,123");
  await expect(
    spreadsheet.run(
      {
        action: "import_csv",
        csvPath: "private.csv",
        path: "artifacts/result.xlsx",
      },
      context
    )
  ).rejects.toThrow();
  const docx = tools.find((tool) => tool.name === "write_docx")!;
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  await writeFile(join(root, "private.png"), image);
  await writeFile(join(artifacts, "chart.png"), image);
  const finishedDocx = await docx.run(
    {
      markdown: "# Report\n\n![chart](artifacts/chart.png)",
      path: "artifacts/report.docx",
    },
    context
  );
  expect(JSON.stringify(finishedDocx)).toContain("report.docx");

  await expect(
    docx.run(
      { markdown: "![private](private.png)", path: "artifacts/leak.docx" },
      context
    )
  ).rejects.toThrow();
  let attachmentLoads = 0;
  await expect(
    docx.run(
      { markdown: "![private](att_other)", path: "artifacts/leak.docx" },
      {
        ...context,
        loadAttachment: async () => {
          attachmentLoads++;
          throw new Error("must not reach attachment storage");
        },
      }
    )
  ).rejects.toThrow();
  expect(attachmentLoads).toBe(0);

  await expect(
    spreadsheet.run(
      {
        action: "export_csv",
        path: "artifacts/sales.xlsx",
        targetCsvPath: "MEMORY.md",
      },
      context
    )
  ).rejects.toThrow();
});

test("older paired profiles get file tools without replacing assigned implementations", async () => {
  const custom = {
    description: "Assigned reader",
    name: "read_file",
    run: async () => "assigned",
  };
  const tools = await resolveExecutableToolsForPrincipal(
    "user_member",
    async () => [custom],
    { channel: "telegram" }
  );
  expect(tools.filter((tool) => tool.name === custom.name)).toEqual([custom]);
  for (const name of [
    "spreadsheet",
    "extract_document_text",
    "write_file",
    "python_execute",
    "write_docx",
    "write_pptx",
  ]) {
    expect(tools.some((tool) => tool.name === name)).toBe(true);
  }
});

for (const channel of ["whatsapp", "telegram", "discord"] as const) {
  test(`${channel} guest file tool passes the protected executor only with current authorization`, async () => {
    const tool = channelWorkFileTools(true).find(
      (candidate) => candidate.name === "write_file"
    )!;
    let authorizations = 0;
    const context = buildToolExecutionContext({
      beforeToolCall: async () => {
        authorizations++;
      },
      channel,
      orgId,
      profileId,
      userId: guestId,
    });
    const input = { content: "Ready to use", path: "artifacts/finished.txt" };
    const result = await executeProtectedTool(tool, input, context);
    expect(result.success).toBe(true);
    expect(authorizations).toBe(1);
    const revoked = await executeProtectedTool(tool, input, {
      ...context,
      beforeToolCall: async () => {
        throw new Error("Sender was revoked");
      },
    });
    expect(revoked.success).toBe(false);
    const unguarded = await executeProtectedTool(tool, input, {
      ...context,
      beforeToolCall: undefined,
    });
    expect(unguarded.success).toBe(false);
    const wrongChannel = await executeProtectedTool(tool, input, {
      ...context,
      channel: "web",
    });
    expect(wrongChannel.success).toBe(false);
    const viewer = await executeProtectedTool(tool, input, {
      ...context,
      orgRole: "viewer",
    });
    expect(viewer.success).toBe(false);
  });
}

test("channel text reader can reach the end of an accepted file above the old 10 MB read limit", async () => {
  const artifacts = getProfileArtifactsDir(orgId, profileId);
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(artifacts, "large.txt"),
    `${("x".repeat(2048) + "\n").repeat(6000)}final source row`
  );
  const reader = channelWorkFileTools(true).find(
    (tool) => tool.name === "read_file"
  )!;
  const result = await reader.run(
    { limit: 1, offset: 6001, path: "artifacts/large.txt" },
    buildToolExecutionContext({
      channel: "telegram",
      orgId,
      profileId,
      userId: guestId,
    })
  );
  expect(result).toMatchObject({
    content: "final source row",
    totalLines: 6001,
  });
});
