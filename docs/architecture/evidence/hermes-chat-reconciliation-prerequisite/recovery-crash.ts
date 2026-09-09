import { writeSync } from "node:fs";
import { createSqliteDatabase } from "./source/packages/db/src/index.ts";

const file = process.argv[2]!;
const mode = process.argv[3]!;
const database = await createSqliteDatabase(`file:${file}`);
const db = database.adapter;
const old = (await db.getExecutionRun("restart-run"))!;
if (mode === "mutate") {
  const at = new Date().toISOString();
  const claimed = await db.casExecutionRun({
    expectedLeaseOwner: old.leaseOwner!,
    id: old.id,
    next: {
      ...old,
      checkpoint: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      status: "cancelled",
      updatedAt: at,
    },
    nowIso: at,
    requireExpiredLease: true,
  });
  if (!claimed) {
    throw new Error("Fixture run could not be terminalized");
  }
  writeSync(
    1,
    JSON.stringify({
      approval: await db.getActionApproval("restart-approval"),
      event: "after-run-cas-before-steps",
      run: await db.getExecutionRun(old.id),
      steps: await db.listExecutionSteps(old.id),
    }) + "\n"
  );
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  const at = new Date().toISOString();
  const retry = await db.casExecutionRun({
    id: old.id,
    next: {
      ...old,
      checkpoint: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      status: "cancelled",
      updatedAt: at,
    },
    nowIso: at,
    requireExpiredLease: true,
  });
  writeSync(
    1,
    JSON.stringify({
      approval: await db.getActionApproval("restart-approval"),
      event: "reopened-after-recovery-crash",
      retryClaim: retry,
      run: await db.getExecutionRun(old.id),
      steps: await db.listExecutionSteps(old.id),
    }) + "\n"
  );
  database.close();
}
