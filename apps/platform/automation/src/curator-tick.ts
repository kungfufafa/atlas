import type { AtlasClient } from "@atlas/client";

type SkillCuratorTickClient = Pick<
  AtlasClient,
  "listSkillCuratorOrgs" | "runSkillCuratorDueInternal"
>;

export interface SkillCuratorTickResult {
  failed: number;
  ran: number;
  skipped: number;
}

export async function tickSkillCurator(
  client: SkillCuratorTickClient
): Promise<SkillCuratorTickResult> {
  const { orgs } = await client.listSkillCuratorOrgs();
  const result: SkillCuratorTickResult = { failed: 0, ran: 0, skipped: 0 };

  for (const organization of orgs) {
    try {
      const response = await client.runSkillCuratorDueInternal(organization.id);
      if (response.result) {
        result.ran += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[automation-worker] skill curator failed for org=${organization.id}: ${message}`
      );
    }
  }

  return result;
}
