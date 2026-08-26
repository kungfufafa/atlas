import type { ProfileSummary } from "@atlas/core/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/context/use-auth";
import { useProfilesQuery } from "@/hooks/use-app-queries";
import { useUpdateProfileMutation } from "@/hooks/use-resource-mutations";
import { client, formatError } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "@/lib/toast";

type OverrideValue = "inherit" | "on" | "off";

function toOverride(value: boolean | null | undefined): OverrideValue {
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  return "inherit";
}

function fromOverride(value: OverrideValue): boolean | null {
  if (value === "on") {
    return true;
  }
  if (value === "off") {
    return false;
  }
  return null;
}

function ProfileOverride({ profile }: { profile: ProfileSummary }) {
  const mutation = useUpdateProfileMutation();
  const [value, setValue] = useState(() =>
    toOverride(profile.skillsCuratorConsolidation)
  );

  const update = async (next: OverrideValue) => {
    setValue(next);
    try {
      await mutation.mutateAsync({
        input: { skillsCuratorConsolidation: fromOverride(next) },
        profileId: profile.id,
      });
      toast("Profile skill consolidation setting saved.");
    } catch (error) {
      setValue(toOverride(profile.skillsCuratorConsolidation));
      toast(formatError(error));
    }
  };

  return (
    <Select
      disabled={mutation.isPending}
      onValueChange={(next) => {
        if (next) {
          void update(next as OverrideValue);
        }
      }}
      value={value}
    >
      <SelectTrigger
        aria-label="Skill consolidation profile override"
        className="h-8 max-w-xs"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="inherit">Inherit org default</SelectItem>
        <SelectItem value="on">Enable consolidation</SelectItem>
        <SelectItem value="off">Disable consolidation</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function SkillsCuratorOrgCard() {
  const { activeOrg, updateOrg } = useAuth();
  const { data: profiles = [] } = useProfilesQuery();
  const queryClient = useQueryClient();
  const [profileId, setProfileId] = useState("all");
  const [toggleBusy, setToggleBusy] = useState(false);
  const orgId = activeOrg?.id ?? "";
  const status = useQuery({
    enabled: Boolean(orgId && activeOrg?.role === "admin"),
    queryFn: () => client.getSkillCuratorStatus(orgId),
    queryKey: queryKeys.skillCurator(orgId),
  });
  const run = useMutation({
    mutationFn: () =>
      client.runSkillCurator(
        orgId,
        profileId === "all" ? undefined : profileId
      ),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.skillCurator(orgId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.skillProposals(orgId),
        }),
      ]);
      toast(
        result.staged > 0
          ? `${result.staged} consolidation proposal${result.staged === 1 ? "" : "s"} ready for review.`
          : "No safe consolidation candidates found."
      );
    },
  });

  if (!activeOrg || activeOrg.role !== "admin") {
    return null;
  }

  const selectedProfile =
    profiles.find((profile) => profile.id === profileId) ?? null;
  const enabledForRun = selectedProfile
    ? (selectedProfile.skillsCuratorConsolidation ??
      activeOrg.skillsCuratorConsolidation === true)
    : activeOrg.skillsCuratorConsolidation === true;

  const toggle = async (checked: boolean) => {
    setToggleBusy(true);
    try {
      await updateOrg(activeOrg.id, { skillsCuratorConsolidation: checked });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.skillCurator(activeOrg.id),
      });
      toast(
        checked
          ? "Skill consolidation enabled."
          : "Skill consolidation disabled."
      );
    } catch (error) {
      toast(formatError(error));
    } finally {
      setToggleBusy(false);
    }
  };

  return (
    <Card className="w-full overflow-hidden shadow-none">
      <div className="flex items-center justify-between gap-4 border-border border-b px-4 py-3">
        <p className="font-medium text-foreground text-sm">
          Skill consolidation
        </p>
        <div className="flex items-center gap-2">
          {toggleBusy ? <Spinner /> : null}
          <Switch
            aria-label="Enable skill consolidation"
            checked={activeOrg.skillsCuratorConsolidation === true}
            disabled={toggleBusy}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </div>
      </div>
      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            onValueChange={(next) => setProfileId(next ? String(next) : "all")}
            value={profileId}
          >
            <SelectTrigger
              aria-label="Consolidation profile"
              className="h-8 max-w-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All profiles</SelectItem>
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedProfile ? (
            <ProfileOverride
              key={`${selectedProfile.id}:${String(selectedProfile.skillsCuratorConsolidation)}`}
              profile={selectedProfile}
            />
          ) : null}
          <Button
            disabled={!enabledForRun || run.isPending}
            onClick={() => run.mutate()}
            size="sm"
            type="button"
            variant="outline"
          >
            {run.isPending ? <Spinner className="mr-2" /> : null}
            Consolidate now
          </Button>
        </div>
        {run.error ? (
          <p className="text-destructive text-xs" role="alert">
            {formatError(run.error)}
          </p>
        ) : null}
        {status.data?.latest ? (
          <p className="text-muted-foreground text-xs">
            Last run: {status.data.latest.staged} staged,{" "}
            {status.data.latest.considered} considered.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
