import { Copy01Icon, Delete02Icon, Upload04Icon } from "hugeicons-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { ProfileAdminPlusButton } from "@/components/ProfileAdminPlusButton";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { ExportProfileButton } from "@/components/profiles/ExportProfileButton";
import { ProfileImportDialog } from "@/components/profiles/ProfileImportDialog";
import { SkillProposalsPanel } from "@/components/profiles/SkillProposalsPanel";
import { SoulTab } from "@/components/soul-tools/SoulTab";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/context/use-auth";
import { useAppNavigation } from "@/hooks/use-app-navigation";
import { usePageHeaderActions } from "@/hooks/use-page-header-actions";
import { useSkillProposals } from "@/hooks/use-skill-proposals";
import { resolveSuperAgentChatProfileId } from "@/lib/profiles";
import { cn } from "@/lib/utils";
import { ProfileConfigTab } from "@/pages/profiles/profile-config-tab";
import {
  profilePanelHeaderClass,
  profilePanelHeaderLabelClass,
  sectionClass,
} from "@/pages/profiles/profiles-page.shared";
import {
  PageState,
  ProfileDetailTabButton,
  ProfileScopeButton,
  ProfilesEmptyState,
} from "@/pages/profiles/profiles-ui";
import type { ProfilesPageState } from "@/pages/profiles/use-profiles-page";

function ProfilesPageHeaderTablist({
  detail,
  detailTab,
  isOrgAdmin,
  pageHeaderActions,
  pendingSkillProposals,
  selectedId,
  setDetailTab,
}: {
  detail: ProfilesPageState["detail"];
  detailTab: ProfilesPageState["detailTab"];
  isOrgAdmin: boolean;
  pageHeaderActions: HTMLElement | null;
  pendingSkillProposals: number;
  selectedId: string | null;
  setDetailTab: ProfilesPageState["setDetailTab"];
}) {
  if (!(pageHeaderActions && selectedId && detail)) {
    return null;
  }

  return createPortal(
    <div
      aria-label="Profile settings"
      className="no-scrollbar flex h-full min-w-0 items-stretch overflow-x-auto"
      role="tablist"
    >
      <ProfileDetailTabButton
        active={detailTab === "profile"}
        controls="profile-detail-panel-profile"
        id="profile-detail-tab-profile"
        onSelect={() => setDetailTab("profile")}
      >
        Config
      </ProfileDetailTabButton>
      <ProfileDetailTabButton
        active={detailTab === "prompt"}
        controls="profile-detail-panel-prompt"
        id="profile-detail-tab-prompt"
        onSelect={() => setDetailTab("prompt")}
      >
        Prompt
      </ProfileDetailTabButton>
      {isOrgAdmin ? (
        <ProfileDetailTabButton
          active={detailTab === "proposals"}
          controls="profile-detail-panel-proposals"
          id="profile-detail-tab-proposals"
          onSelect={() => setDetailTab("proposals")}
        >
          Proposals
          {pendingSkillProposals > 0 ? (
            <span className="text-amber-600 text-xs tabular-nums dark:text-amber-400">
              ({pendingSkillProposals > 99 ? "99+" : pendingSkillProposals})
            </span>
          ) : null}
        </ProfileDetailTabButton>
      ) : null}
    </div>,
    pageHeaderActions
  );
}

function ProfilesPageDetailPanel({
  activeOrgId,
  busy,
  canCreateProfile,
  detail,
  detailLoading,
  detailTab,
  isOrgAdmin,
  onAskSuperAgent,
  onCreate,
  profilesLength,
  selectedId,
  state,
}: {
  activeOrgId: string | null;
  busy: boolean;
  canCreateProfile: boolean;
  detail: ProfilesPageState["detail"];
  detailLoading: boolean;
  detailTab: ProfilesPageState["detailTab"];
  isOrgAdmin: boolean;
  onAskSuperAgent: (() => void) | undefined;
  onCreate: () => void;
  profilesLength: number;
  selectedId: string | null;
  state: ProfilesPageState;
}) {
  return profilesLength === 0 ? (
    <div className="p-4">
      <ProfilesEmptyState
        canCreate={canCreateProfile}
        disabled={busy}
        onAskSuperAgent={onAskSuperAgent}
        onCreate={onCreate}
        variant="full"
      />
    </div>
  ) : detailLoading && !detail ? (
    <div className="p-4">
      <PageState embedded message="Loading profile…" />
    </div>
  ) : selectedId && detail ? (
    detailTab === "profile" ? (
      <div className="no-scrollbar p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <ProfileConfigTab state={state} />
      </div>
    ) : detailTab === "proposals" && isOrgAdmin && activeOrgId && selectedId ? (
      <div
        aria-labelledby="profile-detail-tab-proposals"
        className="no-scrollbar p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
        id="profile-detail-panel-proposals"
        role="tabpanel"
      >
        <SkillProposalsPanel orgId={activeOrgId} profileId={selectedId} />
      </div>
    ) : detailTab === "prompt" ? (
      <div
        aria-labelledby="profile-detail-tab-prompt"
        className="no-scrollbar p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
        id="profile-detail-panel-prompt"
        role="tabpanel"
      >
        <SoulTab profileId={selectedId} />
      </div>
    ) : null
  ) : (
    <div className="flex min-h-48 items-center justify-center p-4 text-muted-foreground text-sm">
      Select a profile to edit.
    </div>
  );
}

export function ProfilesPageLayout(state: ProfilesPageState) {
  const {
    profiles,
    profilesLoading,
    busy,
    error,
    selectedId,
    detail,
    detailLoading,
    refetchDetail,
    refreshing,
    detailTab,
    setDetailTab,
    handleSelectProfile,
    setCreateOpen,
    setSelectedId,
    handleCloneProfile,
    openDeleteDialog,
  } = state;
  const { user, activeOrg } = useAuth();
  const isOrgAdmin = activeOrg?.role === "admin";
  const canCreateProfile = user?.isPlatformAdmin === true || isOrgAdmin;
  const { navigateToNewChat } = useAppNavigation();
  const superAgentProfileId = resolveSuperAgentChatProfileId(profiles);
  const { data: skillProposalsData } = useSkillProposals(
    isOrgAdmin && selectedId ? (activeOrg?.id ?? null) : null,
    { profileId: selectedId ?? undefined, status: "pending" }
  );
  const pendingSkillProposals = skillProposalsData?.pendingCount ?? 0;
  const onAskSuperAgent = superAgentProfileId
    ? () => navigateToNewChat(superAgentProfileId)
    : undefined;
  const pageHeaderActions = usePageHeaderActions();
  const [importOpen, setImportOpen] = useState(false);

  if (profilesLoading && profiles.length === 0) {
    return <PageState message="Loading profiles…" />;
  }

  return (
    <div className="space-y-4">
      <ProfilesPageHeaderTablist
        detail={detail}
        detailTab={detailTab}
        isOrgAdmin={isOrgAdmin}
        pageHeaderActions={pageHeaderActions}
        pendingSkillProposals={pendingSkillProposals}
        selectedId={selectedId}
        setDetailTab={setDetailTab}
      />
      {pageHeaderActions &&
      selectedId &&
      detail &&
      canCreateProfile &&
      !detail.isSuper
        ? createPortal(
            <>
              <ExportProfileButton disabled={busy} profileId={selectedId} />
              <Button
                aria-label="Clone profile"
                className="hidden self-center lg:inline-flex"
                disabled={busy}
                onClick={() => handleCloneProfile(selectedId)}
                size="sm"
                type="button"
                variant="outline"
              >
                <Copy01Icon aria-hidden className="size-3.5" />
                <span>Clone</span>
              </Button>
              <Button
                aria-label="Delete profile"
                className="hidden self-center text-destructive hover:text-destructive lg:inline-flex"
                disabled={busy}
                onClick={() => openDeleteDialog(selectedId)}
                size="sm"
                type="button"
                variant="outline"
              >
                <Delete02Icon aria-hidden className="size-3.5" />
                <span>Delete</span>
              </Button>
            </>,
            pageHeaderActions
          )
        : null}
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive text-sm">
          {error}
          {selectedId ? (
            <>
              {" "}
              <button
                className="underline underline-offset-2"
                onClick={() => void refetchDetail()}
                type="button"
              >
                Retry
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      <section
        className={cn(
          sectionClass,
          "flex flex-col lg:min-h-[calc(100svh-7rem)] lg:overflow-hidden"
        )}
      >
        <div className="flex flex-col gap-3 border-border border-b p-4 lg:hidden">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              disabled={busy || refreshing || profiles.length === 0}
              onValueChange={(value) => {
                if (value) {
                  handleSelectProfile(String(value));
                }
              }}
              value={selectedId ?? ""}
            >
              <SelectTrigger
                aria-label="Selected profile"
                className="min-w-0 flex-1"
              >
                <SelectValue placeholder="Select profile">
                  {profiles.find((profile) => profile.id === selectedId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    <span className="flex items-center gap-2">
                      <ProfileAvatar profile={profile} size="sm" />
                      <span>{profile.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {canCreateProfile ? (
              <div className="flex items-center gap-1">
                <Button
                  aria-label="Import profile"
                  disabled={busy}
                  onClick={() => setImportOpen(true)}
                  size="icon-sm"
                  title="Import profile"
                  type="button"
                  variant="ghost"
                >
                  <Upload04Icon aria-hidden className="size-4" />
                </Button>
                <ProfileAdminPlusButton
                  disabled={busy}
                  label="New profile"
                  onClick={() => setCreateOpen(true)}
                />
              </div>
            ) : null}
          </div>

          {selectedId && detail && !detail.isSuper ? (
            <div className="flex items-center justify-end gap-2 lg:hidden">
              {canCreateProfile ? (
                <ExportProfileButton disabled={busy} profileId={selectedId} />
              ) : null}
              <Button
                aria-label="Clone profile"
                disabled={busy}
                onClick={() => handleCloneProfile(selectedId)}
                size="sm"
                type="button"
                variant="outline"
              >
                <Copy01Icon aria-hidden className="size-3.5" />
                <span>Clone</span>
              </Button>
              <Button
                aria-label="Delete profile"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => openDeleteDialog(selectedId)}
                size="sm"
                type="button"
                variant="outline"
              >
                <Delete02Icon aria-hidden className="size-3.5" />
                <span>Delete</span>
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
          <aside className="hidden shrink-0 flex-col border-border border-b lg:flex lg:w-56 lg:border-r lg:border-b-0">
            <div className={profilePanelHeaderClass}>
              <span className={profilePanelHeaderLabelClass}>Profiles</span>
              {canCreateProfile ? (
                <div className="flex items-center gap-1">
                  <Button
                    aria-label="Import profile"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={busy}
                    onClick={() => setImportOpen(true)}
                    size="icon-sm"
                    title="Import profile"
                    type="button"
                    variant="ghost"
                  >
                    <Upload04Icon aria-hidden className="size-4" />
                  </Button>
                  <ProfileAdminPlusButton
                    disabled={busy}
                    label="New profile"
                    onClick={() => setCreateOpen(true)}
                    tooltipSide="top"
                  />
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {profiles.length === 0 ? (
                <ProfilesEmptyState
                  canCreate={canCreateProfile}
                  disabled={busy}
                  onAskSuperAgent={onAskSuperAgent}
                  onCreate={() => setCreateOpen(true)}
                  variant="compact"
                />
              ) : (
                <nav aria-label="Profiles" className="flex flex-col gap-1">
                  {profiles.map((profile) => (
                    <ProfileScopeButton
                      active={selectedId === profile.id}
                      disabled={busy}
                      key={profile.id}
                      onClick={() => handleSelectProfile(profile.id)}
                      profile={profile}
                    />
                  ))}
                </nav>
              )}
            </div>
          </aside>

          <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1 lg:overflow-hidden">
            <ProfilesPageDetailPanel
              activeOrgId={activeOrg?.id ?? null}
              busy={busy}
              canCreateProfile={canCreateProfile}
              detail={detail}
              detailLoading={detailLoading}
              detailTab={detailTab}
              isOrgAdmin={isOrgAdmin}
              onAskSuperAgent={onAskSuperAgent}
              onCreate={() => setCreateOpen(true)}
              profilesLength={profiles.length}
              selectedId={selectedId}
              state={state}
            />
          </div>
        </div>
      </section>
      <ProfileImportDialog
        onImported={setSelectedId}
        onOpenChange={setImportOpen}
        open={importOpen}
      />
    </div>
  );
}
