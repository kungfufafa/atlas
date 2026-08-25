import { createHash } from "node:crypto";
import {
  assertCanonicalPrincipal,
  type CanonicalPrincipal,
} from "../identity/principal";
import { applyRedactionBoundary } from "../redaction-boundary";

export type SkillProvenance = "learned" | "human" | "bundled";
export type SkillRegistryStatus =
  | "draft"
  | "quarantined"
  | "canary"
  | "published"
  | "rolled_back";

export interface SkillRevision {
  content: string;
  createdAt: string;
  createdByUserId: string | null;
  digest: string;
  evidenceIds: string[];
  id: string;
  orgId: string;
  provenance: SkillProvenance;
  published: boolean;
  semver: string;
  skillId: string;
  status: SkillRegistryStatus;
  version: number;
}

export class SkillRegistryError extends Error {
  readonly code = "SKILL_REGISTRY";

  constructor(message: string) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

export function digestSkillContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function bumpSemver(previous: string | null | undefined): string {
  if (!previous) {
    return "0.1.0";
  }
  const [major, minor, patch] = previous.split(".").map((part) => Number(part));
  if (
    !(
      Number.isInteger(major) &&
      Number.isInteger(minor) &&
      Number.isInteger(patch)
    )
  ) {
    return "0.1.0";
  }
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

export function nextSkillRevision(input: {
  content: string;
  createdBy?: CanonicalPrincipal | null;
  evidenceIds?: string[];
  id: string;
  orgId: string;
  previousSemver?: string | null;
  previousVersion: number;
  provenance?: SkillProvenance;
  skillId: string;
  now?: string;
}): SkillRevision {
  if (!input.skillId.trim()) {
    throw new SkillRegistryError("skillId is required.");
  }
  if (!input.orgId.trim()) {
    throw new SkillRegistryError("orgId is required.");
  }
  if (input.previousVersion < 0) {
    throw new SkillRegistryError("previousVersion must be >= 0.");
  }

  const content = applyRedactionBoundary(input.content.trim(), "learning");
  if (!content) {
    throw new SkillRegistryError("Skill revision content is required.");
  }

  let createdByUserId: string | null = null;
  if (input.createdBy) {
    createdByUserId = assertCanonicalPrincipal(input.createdBy).userId;
  }

  const provenance = input.provenance ?? "human";
  return {
    content,
    createdAt: input.now ?? new Date().toISOString(),
    createdByUserId,
    digest: digestSkillContent(content),
    evidenceIds: input.evidenceIds ?? [],
    id: input.id,
    orgId: input.orgId,
    provenance,
    published: false,
    semver: bumpSemver(input.previousSemver),
    skillId: input.skillId,
    status: provenance === "learned" ? "draft" : "draft",
    version: input.previousVersion + 1,
  };
}

export function publishSkillRevision(revision: SkillRevision): SkillRevision {
  if (revision.provenance === "learned") {
    throw new SkillRegistryError(
      "Learned skills must never auto-publish. Promote only after human review."
    );
  }
  if (revision.status === "quarantined") {
    throw new SkillRegistryError("Quarantined skills cannot be published.");
  }
  return { ...revision, published: true, status: "published" };
}

export function quarantineSkillRevision(
  revision: SkillRevision
): SkillRevision {
  return { ...revision, published: false, status: "quarantined" };
}

export function rollbackSkillRevision(revision: SkillRevision): SkillRevision {
  return { ...revision, published: false, status: "rolled_back" };
}

export function selectLatestRevision(
  revisions: SkillRevision[]
): SkillRevision | null {
  if (revisions.length === 0) {
    return null;
  }
  return (
    [...revisions].sort((left, right) => right.version - left.version)[0] ??
    null
  );
}
