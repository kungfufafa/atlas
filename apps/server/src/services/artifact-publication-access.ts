import { AtlasApiError } from "@atlas/core";
import type { ArtifactPublicationScope } from "@atlas/core/artifact-publication";
import { canAccessSuperAgentProfile } from "@atlas/core/profiles";
import type { DatabaseAdapter } from "@atlas/db";
import type { AgentService, SessionActor } from "./agent-service";
import { ArtifactPublicationService } from "./artifact-publication-service";
import type { ArtifactPublicationStore } from "./artifact-publication-store";

type PublicationAccess = ArtifactPublicationScope & { actorId: string };
type PublicationAction = "publish" | "read" | "revoke";

/** The actor must come from authenticated host context, including its worker channel. */
export function createPublicationAuthorizer(
  db: DatabaseAdapter,
  agent: Pick<AgentService, "canAccessSession">,
  actor: SessionActor
): (scope: PublicationAccess, action: PublicationAction) => Promise<void> {
  const principal = Object.freeze({ ...actor });
  return async (scope, action) => {
    const [org, session, profile] = await Promise.all([
      db.getOrganizationById(scope.orgId),
      db.getSession(scope.sessionId),
      db.getProfileForOrg(scope.profileId, scope.orgId),
    ]);
    if (
      principal.userId !== scope.actorId ||
      !org ||
      org.archivedAt ||
      !session ||
      session.orgId !== scope.orgId ||
      session.profileId !== scope.profileId ||
      !profile ||
      profile.isImporting
    ) {
      throw new AtlasApiError("Not found", 404);
    }
    // Worker identity is a transport principal, not the session's human owner.
    // Keep the trusted channel on the actor passed to the session ACL below.
    const userId = principal.workspaceWorkerChannel
      ? session.userId
      : principal.userId;
    if (!userId) {
      throw new AtlasApiError("Not found", 404);
    }
    const [user, member] = await Promise.all([
      db.getUserById(userId),
      db.getOrgMember(scope.orgId, userId),
    ]);
    const isPlatformAdmin =
      !principal.workspaceWorkerChannel && user?.isPlatformAdmin === true;
    if (
      !(user && (member || isPlatformAdmin)) ||
      (profile.isSuper &&
        (principal.workspaceWorkerChannel ||
          !canAccessSuperAgentProfile({
            isPlatformAdmin,
            orgRole: member?.role,
          }))) ||
      !(await agent.canAccessSession(
        scope.orgId,
        scope.sessionId,
        principal,
        action === "read" ? "read" : action === "publish" ? "invoke" : "manage"
      ))
    ) {
      throw new AtlasApiError("Not found", 404);
    }
  };
}

export function createSessionPublicationAccess(options: {
  agent: Pick<AgentService, "canAccessSession">;
  db: DatabaseAdapter;
  getStore(): Promise<ArtifactPublicationStore>;
}) {
  return async (
    orgId: string,
    sessionId: string,
    actor: SessionActor,
    action: "read" | "revoke" = "read"
  ) => {
    const session = await options.db.getSession(sessionId);
    if (!session || session.orgId !== orgId) {
      throw new AtlasApiError("Not found", 404);
    }
    const scope = Object.freeze({
      actorId: actor.userId,
      orgId,
      profileId: session.profileId,
      sessionId,
    });
    const authorize = createPublicationAuthorizer(
      options.db,
      options.agent,
      actor
    );
    // Denied requests must not create or touch private snapshot storage.
    await authorize(scope, action);
    const service = new ArtifactPublicationService(
      options.db,
      await options.getStore(),
      authorize
    );
    return { scope, service };
  };
}
