import { useCallback, useEffect, useState } from "react";
import { CapabilityRoutingCard } from "@/components/settings/CapabilityRoutingCard";
import { DataPortabilityPanel } from "@/components/settings/DataPortabilityPanel";
import { ProviderSettingsCard } from "@/components/settings/ProviderSettingsCard";
import { WebPublicUrlSettingsRow } from "@/components/settings/WebPublicUrlSettingsRow";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TimezoneSelect } from "@/components/TimezoneSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/context/use-auth";
import { useSaveUserTimezone, useUserTimezone } from "@/hooks/use-timezones";
import { formatError } from "@/lib/client";
import { getBrowserTimezone } from "@/lib/timezones";

export function canManageWorkspaceSettings({
  isOrgAdmin,
  isPlatformAdmin,
}: {
  isOrgAdmin: boolean;
  isPlatformAdmin: boolean;
}): boolean {
  return isPlatformAdmin || isOrgAdmin;
}

export function providerSettingsScopeKey(activeOrgId: string | null): string {
  return activeOrgId ?? "no-workspace";
}

export function SettingsPage() {
  const { user, activeOrg } = useAuth();
  const isPlatformAdmin = user?.isPlatformAdmin === true;
  const isOrgAdmin = activeOrg?.role === "admin";
  const canManageWorkspace = canManageWorkspaceSettings({
    isOrgAdmin,
    isPlatformAdmin,
  });
  const [providerError, setProviderError] = useState<string | null>(null);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(() => getBrowserTimezone());
  const [timezoneHint, setTimezoneHint] = useState<string | null>(null);
  const { data: savedTimezone } = useUserTimezone();
  const saveTimezoneMutation = useSaveUserTimezone();

  useEffect(() => {
    setProviderError(null);
    setTimezoneError(null);
    setTimezoneHint(null);
  }, [activeOrg?.id]);

  useEffect(() => {
    if (savedTimezone) {
      setTimezone(savedTimezone);
    }
  }, [savedTimezone]);

  const handleSaveTimezone = useCallback(() => {
    setTimezoneError(null);
    setTimezoneHint(null);

    saveTimezoneMutation.mutate(timezone.trim(), {
      onError: (err) => {
        setTimezoneError(formatError(err));
      },
      onSuccess: (saved) => {
        setTimezone(saved);
        setTimezoneHint(`Saved · ${saved}`);
      },
    });
  }, [saveTimezoneMutation, timezone]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card className="w-full shadow-none">
        <CardContent className="divide-y divide-border p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="space-y-0.5">
              <p className="font-medium text-foreground text-sm">Appearance</p>
              <p className="text-pretty text-muted-foreground text-xs">
                Color theme
              </p>
            </div>
            <ThemeToggle />
          </div>

          {canManageWorkspace ? (
            <>
              <div className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium text-foreground text-sm">
                      Timezone
                    </p>
                    {timezoneHint ? (
                      <p
                        className="text-emerald-700 text-xs dark:text-emerald-300"
                        role="status"
                      >
                        {timezoneHint}
                      </p>
                    ) : (
                      <p className="text-pretty text-muted-foreground text-xs">
                        For scheduled automations
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <TimezoneSelect
                      className="w-44 min-w-0 sm:w-52"
                      disabled={saveTimezoneMutation.isPending}
                      emptyLabel="Select timezone"
                      id="timezone"
                      onValueChange={(nextTimezone) => {
                        if (nextTimezone) {
                          setTimezone(nextTimezone);
                          setTimezoneHint(null);
                          setTimezoneError(null);
                        }
                      }}
                      value={timezone}
                    />
                    <Button
                      disabled={
                        saveTimezoneMutation.isPending || !timezone.trim()
                      }
                      onClick={handleSaveTimezone}
                      size="sm"
                      type="button"
                    >
                      {saveTimezoneMutation.isPending ? (
                        <>
                          <Spinner className="mr-2" />
                          Saving…
                        </>
                      ) : (
                        "Save"
                      )}
                    </Button>
                  </div>
                </div>
                {timezoneError ? (
                  <p className="text-destructive text-sm" role="alert">
                    {timezoneError}
                  </p>
                ) : null}
              </div>

              {isPlatformAdmin ? <WebPublicUrlSettingsRow /> : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {canManageWorkspace ? (
        <>
          <ProviderSettingsCard
            formError={providerError}
            key={providerSettingsScopeKey(activeOrg?.id ?? null)}
            onFormError={setProviderError}
          />

          <CapabilityRoutingCard />
        </>
      ) : null}

      {isPlatformAdmin ? (
        <Card className="w-full overflow-hidden shadow-none">
          <CardContent className="p-0">
            <DataPortabilityPanel />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
