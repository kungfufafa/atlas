import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/context/use-auth";
import { agentWorkTabFromSearchParams } from "@/lib/navigation";
import { isViewerRole } from "@/lib/org-roles";
import { AutomationsDialogs } from "@/pages/automations/automations-dialogs";
import { agentWorkPanelClassName } from "@/pages/automations/automations-page.shared";
import { AutomationsPageLayout } from "@/pages/automations/automations-page-layout";
import { useAutomationsPage } from "@/pages/automations/use-automations-page";
import { TasksPage } from "@/pages/TasksPage";

export function AutomationsPage() {
  const { activeOrg } = useAuth();
  const state = useAutomationsPage();
  const [searchParams] = useSearchParams();
  const activeTab = agentWorkTabFromSearchParams(searchParams);

  if (isViewerRole(activeOrg?.role)) {
    return <Navigate replace to="/history" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {activeTab === "automations" ? (
        <div
          aria-labelledby="agent-work-tab-automations"
          className={agentWorkPanelClassName}
          id="agent-work-panel-automations"
          role="tabpanel"
        >
          <AutomationsPageLayout {...state} />
        </div>
      ) : (
        <div
          aria-labelledby="agent-work-tab-tasks"
          className={agentWorkPanelClassName}
          id="agent-work-panel-tasks"
          role="tabpanel"
        >
          <TasksPage />
        </div>
      )}
      <AutomationsDialogs {...state} />
    </div>
  );
}
