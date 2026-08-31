import type { ErrorTrackingSettingsResponse } from "@atlas/core/contract";
import { Link01Icon, ViewIcon, ViewOffIcon } from "hugeicons-react";
import { useState } from "react";
import {
  IntegrationCardShell,
  IntegrationStatusHeader,
} from "@/components/integration-settings.shared";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import {
  useErrorTrackingSettings,
  useSaveErrorTrackingSettings,
  useSendErrorTrackingTest,
} from "@/hooks/use-error-tracking";
import { formatError } from "@/lib/client";

function resolveStatusBadge(
  settings: ErrorTrackingSettingsResponse | undefined
): string {
  if (settings?.disabledByDoNotTrack) {
    return "Disabled by environment";
  }
  if (settings?.configurationSource === "environment") {
    return settings.configured ? "Sending (environment)" : "Off (environment)";
  }
  return settings?.configured ? "Sending" : "Off";
}

function resolveDsnPlaceholder(
  settings: ErrorTrackingSettingsResponse | undefined
): string {
  if (!(settings?.configured && settings.dsnMasked)) {
    return "https://<key>@sentry.example.com/42";
  }
  if (settings.configurationSource === "environment") {
    return `Environment (${settings.dsnMasked})`;
  }
  return `Saved (${settings.dsnMasked})`;
}

export function ErrorTrackingSettingsCard() {
  const {
    data: settings,
    isLoading,
    error: loadError,
  } = useErrorTrackingSettings();
  const saveMutation = useSaveErrorTrackingSettings();
  const testMutation = useSendErrorTrackingTest();
  const [dsn, setDsn] = useState("");
  const [showDsn, setShowDsn] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  if (isLoading) {
    return (
      <IntegrationCardShell busyLabel="Loading error tracking settings">
        <div className="space-y-2 p-5">
          <div className="h-4 w-40 rounded bg-muted" />
          <div className="h-9 w-full rounded bg-muted" />
        </div>
      </IntegrationCardShell>
    );
  }

  const configured = settings?.configured === true;
  const managedByEnvironment =
    settings?.configurationSource === "environment" ||
    settings?.disabledByDoNotTrack === true;
  const statusBadge = resolveStatusBadge(settings);
  const errorMessage = formError ?? (loadError ? formatError(loadError) : null);

  async function handleSave() {
    setFormError(null);
    setTestResult(null);

    try {
      await saveMutation.mutateAsync({ dsn: dsn.trim() });
      setDsn("");
    } catch (error) {
      setFormError(formatError(error));
    }
  }

  async function handleTest() {
    setFormError(null);
    setTestResult(null);

    try {
      const result = await testMutation.mutateAsync();
      setTestResult(
        result.delivered
          ? "Test event delivered. It should appear in your project within a few seconds."
          : "The ingest rejected the event or could not be reached. Check the DSN."
      );
    } catch (error) {
      setFormError(formatError(error));
    }
  }

  return (
    <IntegrationCardShell>
      <IntegrationStatusHeader
        configured={configured}
        connected={configured}
        statusBadge={statusBadge}
        title="Error tracking"
      />

      <div className="border-border border-t" />

      <div className="space-y-2 p-5">
        <div className="min-w-0 space-y-1">
          <label
            className="font-medium text-foreground text-sm"
            htmlFor="error-tracking-dsn"
          >
            Sentry-compatible DSN
          </label>
          <p className="text-muted-foreground text-sm [text-wrap:pretty]">
            Works with Sentry-compatible services. Leave it empty to disable
            delivery.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="h-9 min-w-64 flex-1">
            <InputGroupInput
              autoComplete="off"
              disabled={managedByEnvironment || saveMutation.isPending}
              id="error-tracking-dsn"
              onChange={(event) => {
                setDsn(event.target.value);
                if (formError) {
                  setFormError(null);
                }
              }}
              placeholder={resolveDsnPlaceholder(settings)}
              type={showDsn ? "text" : "password"}
              value={dsn}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label={showDsn ? "Hide DSN" : "Show DSN"}
                className="relative before:absolute before:-inset-2 before:content-['']"
                onClick={() => setShowDsn((current) => !current)}
                size="icon-xs"
                type="button"
              >
                {showDsn ? (
                  <ViewOffIcon className="size-4" />
                ) : (
                  <ViewIcon className="size-4" />
                )}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <Button
            className="min-w-[4.5rem] shrink-0"
            disabled={managedByEnvironment || saveMutation.isPending}
            onClick={() => void handleSave()}
            size="sm"
            type="button"
          >
            {saveMutation.isPending ? <Spinner className="size-4" /> : "Save"}
          </Button>
          <Button
            className="shrink-0"
            disabled={!configured || testMutation.isPending}
            onClick={() => void handleTest()}
            size="sm"
            type="button"
            variant="outline"
          >
            {testMutation.isPending ? (
              <Spinner className="size-4" />
            ) : (
              "Send test event"
            )}
          </Button>
        </div>

        {testResult ? (
          <p className="text-muted-foreground text-sm" role="status">
            {testResult}
          </p>
        ) : null}

        {errorMessage ? (
          <p className="text-destructive text-sm" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </div>

      <div className="px-5 py-3">
        <a
          className="inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
          href="https://docs.sentry.io/concepts/key-terms/dsn-explainer/"
          rel="noopener noreferrer"
          target="_blank"
        >
          <Link01Icon aria-hidden className="size-3.5 shrink-0" />
          <span>
            Find your DSN:{" "}
            <span className="font-medium text-primary">
              Project Settings → Client Keys
            </span>
          </span>
        </a>
      </div>
    </IntegrationCardShell>
  );
}
