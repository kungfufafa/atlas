import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGuard } from "@/components/AuthGuard";
import { ArtifactWorkspace } from "@/components/artifacts/ArtifactWorkspace";
import { ArtifactWorkspaceProvider } from "@/components/artifacts/ArtifactWorkspaceContext";
import { Layout } from "@/components/Layout";
import { SetupGuard } from "@/components/SetupGuard";
import { WorkspaceAdminGuard } from "@/components/WorkspaceAdminGuard";
import { AppProvider } from "@/context/app-context";
import { AuthProvider } from "@/context/auth-context";
import { AppQueryPrefetch } from "@/hooks/use-app-queries";
import { statusTabPath } from "@/lib/navigation";
import { onGlobalQueryError, queryClient } from "@/lib/query-client";
import { AutomationsPage } from "@/pages/AutomationsPage";
import { ChatPage } from "@/pages/ChatPage";
import { FilesPage } from "@/pages/FilesPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { IntegrationsPage } from "@/pages/IntegrationsPage";
import { InvitePage } from "@/pages/InvitePage";
import { LoginPage } from "@/pages/LoginPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { ProfilesPage } from "@/pages/ProfilesPage";
import { PublicArtifactSharePage } from "@/pages/PublicArtifactSharePage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SetupWizardPage } from "@/pages/SetupWizardPage";
import { SkillDetailPage } from "@/pages/SkillDetailPage";
import { SystemPage } from "@/pages/SystemPage";
import { ToolPlaygroundPage } from "@/pages/ToolPlaygroundPage";

function QueryCacheListener() {
  useEffect(() => {
    const unsub = queryClient.getQueryCache().subscribe(onGlobalQueryError);
    return unsub;
  }, []);
  return null;
}

function AppShell() {
  return (
    <QueryClientProvider client={queryClient}>
      <QueryCacheListener />
      <AuthProvider>
        <AppQueryPrefetch />
        <AppProvider>
          <ArtifactWorkspaceProvider>
            <Routes>
              <Route element={<SetupWizardPage />} path="/setup" />
              <Route element={<LoginPage />} path="/login" />
              <Route element={<InvitePage />} path="/invite" />
              <Route element={<PublicArtifactSharePage />} path="/s/:token" />
              <Route element={<AuthGuard />}>
                <Route element={<SetupGuard />}>
                  <Route element={<Layout />}>
                    <Route element={<Navigate replace to="/chat" />} index />
                    <Route
                      element={<Navigate replace to={statusTabPath()} />}
                      path="/status"
                    />
                    <Route element={<ChatPage />} path="/chat">
                      <Route path=":profileId/:sessionId" />
                    </Route>
                    <Route element={<HistoryPage />} path="/history" />
                    <Route
                      element={<ToolPlaygroundPage />}
                      path="/system/playground/:toolId"
                    />
                    <Route element={<SystemPage />} path="/system" />
                    <Route element={<WorkspaceAdminGuard />}>
                      <Route element={<FilesPage />} path="/files" />
                      <Route element={<ProfilesPage />} path="/profiles" />
                      <Route
                        element={<SkillDetailPage />}
                        path="/profiles/skills/:skillId"
                      />
                    </Route>
                    <Route element={<AutomationsPage />} path="/automations" />
                    <Route
                      element={<Navigate replace to="/automations?tab=tasks" />}
                      path="/tasks"
                    />
                    <Route
                      element={<IntegrationsPage />}
                      path="/integrations"
                    />
                    <Route
                      element={<NotificationsPage />}
                      path="/notifications"
                    />
                    <Route element={<SettingsPage />} path="/settings" />
                    <Route element={<Navigate replace to="/chat" />} path="*" />
                  </Route>
                </Route>
              </Route>
            </Routes>
            <ArtifactWorkspace />
          </ArtifactWorkspaceProvider>
        </AppProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export function App() {
  return <AppShell />;
}
