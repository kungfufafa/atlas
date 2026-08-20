import { AsyncLocalStorage } from "node:async_hooks";

/** Per-async-context org override so concurrent channel chats do not share `AtlasClient.orgId`. */
type OrgIdScope = { orgId: string | null };

const orgIdScope = new AsyncLocalStorage<OrgIdScope>();

export function runWithOrgIdScope<T>(orgId: string | null, fn: () => T): T {
  return orgIdScope.run({ orgId }, fn);
}

export function getOrgIdScope(): OrgIdScope | undefined {
  return orgIdScope.getStore();
}
