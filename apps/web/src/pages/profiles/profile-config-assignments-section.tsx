import { BASH_TOOL_ID } from "@atlas/core/tools/protected";
import { useAppNavigation } from "@/hooks/use-app-navigation";
import { ProfileComposioSection } from "@/pages/profiles/profile-composio-section";
import { ProfileMcpSection } from "@/pages/profiles/profile-mcp-section";
import { ProfileSkillsSection } from "@/pages/profiles/profile-skills-section";
import { ProfileToolsSection } from "@/pages/profiles/profile-tools-section";
import type { ProfilesPageState } from "@/pages/profiles/use-profiles-page";

export function ProfileConfigAssignmentsSection({
  state,
}: {
  state: ProfilesPageState;
}) {
  const {
    detail,
    busy,
    allTools,
    handleAssignTool,
    handleSetToolAssigned,
    toolsError,
    toolsLoading,
    setRemoveConfirm,
    allMcpServers,
    availableMcpServers,
    setMcpCreateOpen,
    handleAssignMcpServer,
    composioToolkitsData,
    assignedComposioToolkits,
    availableComposioToolkits,
    handleAssignComposioToolkit,
    allSkills,
    assignedSkillIds,
    setSkillCreateOpen,
    setSkillInstallOpen,
    handleAssignSkill,
    handleDeleteSkill,
    selectedId,
  } = state;
  const { navigateToSkillDetail } = useAppNavigation();

  if (!detail) {
    return null;
  }

  return (
    <>
      <ProfileToolsSection
        busy={busy}
        detail={detail}
        onAssignmentChange={handleSetToolAssigned}
        tools={allTools}
        toolsLoadFailed={Boolean(toolsError)}
        toolsLoading={toolsLoading}
      />
      <ProfileMcpSection
        allMcpServers={allMcpServers}
        availableMcpServers={availableMcpServers}
        busy={busy}
        detail={detail}
        onAssign={handleAssignMcpServer}
        onCreateOpen={() => setMcpCreateOpen(true)}
        onRemove={setRemoveConfirm}
      />
      <ProfileComposioSection
        assignedComposioToolkits={assignedComposioToolkits}
        availableComposioToolkits={availableComposioToolkits}
        busy={busy}
        composioToolkitsData={composioToolkitsData}
        onAssign={handleAssignComposioToolkit}
        onRemove={setRemoveConfirm}
      />
      <ProfileSkillsSection
        allSkills={allSkills}
        assignedSkillIds={assignedSkillIds}
        busy={busy}
        detail={detail}
        onAssign={handleAssignSkill}
        onAssignBash={() => handleAssignTool(BASH_TOOL_ID)}
        onCreateOpen={() => setSkillCreateOpen(true)}
        onDelete={handleDeleteSkill}
        onInstallOpen={() => setSkillInstallOpen(true)}
        onRemove={setRemoveConfirm}
        onViewDetail={(skillId) => {
          navigateToSkillDetail(skillId, {
            profileId: selectedId ?? undefined,
          });
        }}
      />
    </>
  );
}
