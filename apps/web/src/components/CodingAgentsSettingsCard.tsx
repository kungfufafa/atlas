import type { CodingHarnessSettingsResponse } from "@atlas/core/contract";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { client, formatError } from "@/lib/client";

export function CodingAgentsSettingsCard({ orgId }: { orgId: string }) {
  const [settings, setSettings] =
    useState<CodingHarnessSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const currentOrgId = useRef(orgId);
  currentOrgId.current = orgId;

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);
    setSaving(false);
    void client
      .getCodingHarnessSettings(orgId)
      .then((response) => {
        if (!cancelled) {
          setSettings(response);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(formatError(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const toggleProviderPassthrough = async (enabled: boolean) => {
    const requestedOrgId = orgId;
    setSaving(true);
    setError(null);
    try {
      const response = await client.setCodingHarnessSettings(
        enabled,
        requestedOrgId
      );
      if (currentOrgId.current === requestedOrgId) {
        setSettings(response);
      }
    } catch (cause) {
      if (currentOrgId.current === requestedOrgId) {
        setError(formatError(cause));
      }
    } finally {
      if (currentOrgId.current === requestedOrgId) {
        setSaving(false);
      }
    }
  };

  if (!(settings || error)) {
    return (
      <div className="flex min-h-32 items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }

  const providerPassthroughEnabled =
    settings?.providerPassthroughEnabled !== false;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium text-sm">Use Atlas provider</span>
        <Switch
          aria-label="Use Atlas provider for coding agents"
          checked={providerPassthroughEnabled}
          disabled={saving || !settings}
          onCheckedChange={(enabled) => {
            void toggleProviderPassthrough(enabled);
          }}
        />
      </div>

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      {providerPassthroughEnabled ? null : (
        <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <p>
            Coding agents use login credentials on this server. Run the needed
            command on the host:
          </p>
          <ul className="space-y-1 font-mono text-xs">
            {settings?.loginCommands.map((item) => (
              <li key={item.command}>
                {item.name}: {item.command}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            The mode is scoped to this workspace; host credentials remain shared
            infrastructure controlled by the Superadmin.
          </p>
        </div>
      )}
    </div>
  );
}
