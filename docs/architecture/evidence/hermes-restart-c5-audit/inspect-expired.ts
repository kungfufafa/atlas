import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ChatToolApprovalService } from "/Users/apriansyahrs/Documents/Code/atlas/apps/server/src/services/chat-tool-approval-service.ts";
import { ExecutionPlaneService } from "/Users/apriansyahrs/Documents/Code/atlas/apps/server/src/services/execution-plane-service.ts";
import { SessionTurnRegistry } from "/Users/apriansyahrs/Documents/Code/atlas/apps/server/src/services/session-turn-registry.ts";
import {
  AtlasApiError,
  runWithUserConfigDir,
} from "/Users/apriansyahrs/Documents/Code/atlas/packages/core/src/index.ts";
import { createSqliteDatabase } from "/Users/apriansyahrs/Documents/Code/atlas/packages/db/src/index.ts";

const directory = process.argv[2]!;
await runWithUserConfigDir(join(directory, "config"), async () => {
  const database = await createSqliteDatabase(
    `file:${join(directory, "restart.sqlite")}`
  );
  const db = database.adapter;
  const plane = new ExecutionPlaneService(db);
  const service = new ChatToolApprovalService(db, plane);
  const initial = await db.getExecutionRun("restart-run");
  if (
    !initial?.leaseExpiresAt ||
    Date.parse(initial.leaseExpiresAt) >= Date.now()
  ) {
    throw new Error(
      "Lease has not expired yet; do not infer from an unexpired read"
    );
  }
  let decision: unknown;
  try {
    decision = await service.decide({
      approvalId: "restart-approval",
      decision: "approved",
      principal: {
        isPlatformAdmin: false,
        orgId: "restart-org",
        orgRole: "member",
        userId: "restart-user",
      },
      sessionId: "restart-session",
    });
  } catch (error) {
    decision = {
      message: error instanceof Error ? error.message : String(error),
      rejected: true,
      status: error instanceof AtlasApiError ? error.status : null,
    };
  }
  const result = {
    activeRuns: await plane.listActiveRuns({
      kind: "chat",
      orgId: "restart-org",
      sessionId: "restart-session",
    }),
    after: await db.getExecutionRun("restart-run"),
    approval: await db.getActionApproval("restart-approval"),
    before: initial,
    counter: readFileSync(join(directory, "effects.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean).length,
    decision,
    leaseExpired: true,
    modelCalls: 0,
    mutationInvocations: 0,
    observedAt: new Date().toISOString(),
    registry: new SessionTurnRegistry().getStatus("restart-session"),
    steps: await db.listExecutionSteps("restart-run"),
  };
  writeSync(1, `${JSON.stringify(result)}\n`);
  database.close();
});
