import type { SessionActor } from "../services/agent-service";
import type { RequestAuthContext } from "./shared";

export function sessionActorFromAuth(auth: RequestAuthContext): SessionActor {
  return {
    isPlatformAdmin: auth.isPlatformAdmin,
    orgRole: auth.orgRole,
    userId: auth.user.id,
    ...(auth.workspaceWorker
      ? { workspaceWorkerChannel: auth.workspaceWorker.channel }
      : {}),
  };
}
