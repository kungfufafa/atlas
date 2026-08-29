import { Redirect } from "expo-router";
import type { ReactNode } from "react";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";

export function RequireWorkspaceAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useWorkspaceAccess();
  if (!isAdmin) {
    return <Redirect href="/(app)/(tabs)/chats" />;
  }
  return children;
}

export function RequireWorkspaceMutation({
  children,
}: {
  children: ReactNode;
}) {
  const { canMutate } = useWorkspaceAccess();
  if (!canMutate) {
    return <Redirect href="/(app)/(tabs)/chats" />;
  }
  return children;
}

export function RequireIntegrationsAccess({
  children,
}: {
  children: ReactNode;
}) {
  const { canAccessIntegrations } = useWorkspaceAccess();
  if (!canAccessIntegrations) {
    return <Redirect href="/(app)/(tabs)/more" />;
  }
  return children;
}
