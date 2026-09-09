import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeProtectedTool, type ToolContext } from "@atlas/core";
import { editFileTool, writeFileTool } from "@atlas/core/tools/builtin";
import {
  createInMemoryDatabaseAdapter,
  createSqliteDatabase,
  type DatabaseAdapter,
} from "@atlas/db";
import { ChatToolApprovalService } from "../services/chat-tool-approval-service";
import { ExecutionPlaneService } from "../services/execution-plane-service";
import { MemoryService } from "../services/memory-service";
import { createMemoryTools } from "./memory-tools";

const principal = {
  isPlatformAdmin: false,
  orgId: "memory-lifecycle-org",
  orgRole: "member" as const,
  userId: "memory-lifecycle-user",
};
const sessionId = "memory-lifecycle-session";
const oldPreference = "Use email for account notifications.";
const withdrawnPreference =
  "No current account notification channel preference is set.";
const unrelatedFact = "The service desk opens on weekdays.";
const scaffold = "# Memory Log\n\n---\n";

// These tests exercise the native capabilities and authority boundaries that
// the guidance recommends. They do not claim an LLM will select this workflow.
async function fixture(kind: "sqlite" | "in-memory") {
  const directory = mkdtempSync(join(tmpdir(), "memory-withdrawal-native-"));
  const file = join(directory, "memory.sqlite");
  const workspaceRoot = join(directory, "profile");
  const context: ToolContext = {
    ...principal,
    profileId: "memory-lifecycle-profile",
    sessionId,
    workspaceRoot,
  };
  let sqlite = kind === "sqlite" ? await createSqliteDatabase(file) : null;
  let db: DatabaseAdapter = sqlite?.adapter ?? createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: principal.orgId,
    name: "Memory lifecycle",
    slug: "memory-lifecycle",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "memory-lifecycle@example.test",
    id: principal.userId,
    name: "Memory owner",
    passwordHash: "fixture-only",
    updatedAt: now,
  });
  function tool(name: string) {
    const selected = createMemoryTools(new MemoryService(db)).find(
      (entry) => entry.name === name
    );
    if (!selected) {
      throw new Error(`Missing native tool ${name}`);
    }
    return selected;
  }
  return {
    close() {
      sqlite?.close();
      rmSync(directory, { force: true, recursive: true });
    },
    context,
    database() {
      return db;
    },
    directory,
    profileMemory() {
      return readFileSync(join(workspaceRoot, "MEMORY.md"), "utf8");
    },
    async reopen() {
      if (sqlite) {
        sqlite.close();
        sqlite = await createSqliteDatabase(file);
        db = sqlite.adapter;
      }
    },
    async run(
      name: string,
      input: Record<string, unknown>,
      selectedContext: ToolContext = context
    ) {
      const result = await executeProtectedTool(
        tool(name),
        input,
        selectedContext
      );
      if (!result.success) {
        throw new Error(JSON.stringify(result.error));
      }
      return result.data as Record<string, unknown>;
    },
    tool,
    async writeProfile(content: string) {
      return await executeProtectedTool(
        writeFileTool,
        { content, path: "MEMORY.md" },
        context
      );
    },
  };
}

for (const adapter of ["sqlite", "in-memory"] as const) {
  describe(`${adapter} native memory lifecycle`, () => {
    test("withdrawal replaces active DB and file copies while preserving unrelated facts after reopen", async () => {
      const f = await fixture(adapter);
      try {
        const saved = await f.run("memory_write", {
          content: oldPreference,
          subject: "account_notifications",
        });
        const unrelated = await f.run("memory_write", {
          content: unrelatedFact,
          subject: "service_desk",
        });
        expect(
          (
            await f.writeProfile(
              `${scaffold}\n- ${oldPreference}\n- ${unrelatedFact}\n`
            )
          ).success
        ).toBe(true);
        await f.run("memory_update", {
          content: withdrawnPreference,
          id: saved.id,
        });
        const edit = await executeProtectedTool(
          editFileTool,
          {
            edits: [{ newText: withdrawnPreference, oldText: oldPreference }],
            path: "MEMORY.md",
          },
          f.context
        );
        expect(edit.success).toBe(true);
        await f.reopen();
        const recalled = await f.run("memory_search", {
          query: "account notifications",
          scope: "user",
        });
        expect(recalled.memories).toEqual([
          expect.objectContaining({
            content: withdrawnPreference,
            id: saved.id,
          }),
        ]);
        expect(
          await f.database().getMemory(principal.orgId, String(unrelated.id))
        ).toMatchObject({ content: unrelatedFact });
        expect(f.profileMemory()).toBe(
          `${scaffold}\n- ${withdrawnPreference}\n- ${unrelatedFact}\n`
        );
        expect((await f.run("memory_list", { scope: "user" })).count).toBe(2);
      } finally {
        f.close();
      }
    });

    test("DB-only withdrawal does not replicate private memory into a shared profile or allow another user to change it", async () => {
      const f = await fixture(adapter);
      try {
        expect((await f.writeProfile(scaffold)).success).toBe(true);
        const saved = await f.run("memory_write", {
          content: oldPreference,
          subject: "account_notifications",
        });
        await f.run("memory_update", {
          content: withdrawnPreference,
          id: saved.id,
        });
        await f.reopen();
        expect(f.profileMemory()).toBe(scaffold);
        const otherUser = { ...f.context, userId: "another-user" };
        expect(
          (
            await f.run(
              "memory_search",
              { query: "account notifications" },
              otherUser
            )
          ).count
        ).toBe(0);
        const unauthorized = await executeProtectedTool(
          f.tool("memory_update"),
          { content: "Change someone else's preference.", id: saved.id },
          otherUser
        );
        expect(unauthorized.success).toBe(false);
        expect(
          await f.database().getMemory(principal.orgId, String(saved.id))
        ).toMatchObject({ content: withdrawnPreference });
      } finally {
        f.close();
      }
    });

    test("a replacement preference updates the existing record rather than retaining two contradictory current values", async () => {
      const f = await fixture(adapter);
      try {
        const saved = await f.run("memory_write", {
          content: oldPreference,
          subject: "account_notifications",
        });
        const correction = "Use the account portal for notifications.";
        await f.run("memory_update", { content: correction, id: saved.id });
        await f.reopen();
        expect(
          (await f.run("memory_search", { query: "account notifications" }))
            .memories
        ).toEqual([
          expect.objectContaining({ content: correction, id: saved.id }),
        ]);
        expect((await f.run("memory_list", { scope: "user" })).count).toBe(1);
      } finally {
        f.close();
      }
    });

    test("requested erasure remains pending or denied without effect and deletes the exact record after ordinary approval", async () => {
      const f = await fixture(adapter);
      try {
        const saved = await f.run("memory_write", {
          content: oldPreference,
          subject: "account_notifications",
        });
        const unrelated = await f.run("memory_write", {
          content: unrelatedFact,
          subject: "service_desk",
        });
        const initialFile = `${scaffold}\n- ${oldPreference}\n- ${unrelatedFact}\n`;
        expect((await f.writeProfile(initialFile)).success).toBe(true);
        const tool = f.tool("memory_delete");
        const args = { id: saved.id };
        const unapproved = await executeProtectedTool(tool, args, f.context);
        expect(unapproved.success).toBe(false);
        expect(unapproved.error?.code).toBe("PERMISSION_DENIED");

        const db = f.database();
        const approvals = new ChatToolApprovalService(
          db,
          new ExecutionPlaneService(db)
        );
        for (const decision of ["denied", "approved"] as const) {
          const approvalId = `erase-${decision}`;
          const ready = Promise.withResolvers<void>();
          const call = {
            arguments: args,
            id: `call-${decision}`,
            name: tool.name,
          };
          const runId = `run-${decision}`;
          const waiting = approvals.request(
            {
              approval: {
                consequenceSummary: "Delete the selected stored preference.",
                createdAt: new Date().toISOString(),
                id: approvalId,
                status: "pending",
                title: "Delete stored preference",
                tool: tool.name,
                toolCallId: call.id,
              },
              beforeDecision: () => Promise.resolve(),
              call,
              principal,
              runId,
              sessionId,
            },
            ready.resolve
          );
          await ready.promise;
          expect((await db.getActionApproval(approvalId))?.status).toBe(
            "pending"
          );
          expect((await db.getExecutionRun(runId))?.status).toBe(
            "awaiting_approval"
          );
          expect(
            await db.getMemory(principal.orgId, String(saved.id))
          ).toMatchObject({ content: oldPreference });
          expect(f.profileMemory()).toBe(initialFile);
          await approvals.decide({
            approvalId,
            decision,
            principal,
            sessionId,
          });
          const outcome = await waiting;
          expect(outcome.decision).toBe(decision);
          if (outcome.decision === "approved") {
            const erased = await executeProtectedTool(tool, args, {
              ...f.context,
              approvalGrantId: outcome.grantId,
              runId,
            });
            expect(erased.success).toBe(true);
            expect(erased.data).toMatchObject({ deleted: true, id: saved.id });
            await approvals.complete(runId, "completed", [
              { call, content: JSON.stringify(erased.data) },
            ]);
          } else {
            expect(
              await db.getMemory(principal.orgId, String(saved.id))
            ).toMatchObject({ content: oldPreference });
            expect(f.profileMemory()).toBe(initialFile);
          }
        }

        // The authorized active-file copy is a separate effect. No archive or
        // inactive marker substitutes for the explicitly requested removal.
        expect(
          (
            await executeProtectedTool(
              editFileTool,
              {
                edits: [{ newText: "", oldText: `- ${oldPreference}\n` }],
                path: "MEMORY.md",
              },
              f.context
            )
          ).success
        ).toBe(true);
        await f.reopen();
        expect(
          await f.database().getMemory(principal.orgId, String(saved.id))
        ).toBeNull();
        expect(
          (await f.run("memory_search", { query: "account notifications" }))
            .count
        ).toBe(0);
        expect(
          await f.database().getMemory(principal.orgId, String(unrelated.id))
        ).toMatchObject({ content: unrelatedFact });
        expect(f.profileMemory()).not.toContain(oldPreference);
        expect(f.profileMemory()).toContain(`- ${unrelatedFact}\n`);
        expect(readdirSync(String(f.context.workspaceRoot))).toEqual([
          "MEMORY.md",
        ]);
      } finally {
        f.close();
      }
    });
  });
}
