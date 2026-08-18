import type { PreviewOrgInviteResponse } from "@atlas/core/contract";
import { validateSetupPassword } from "@atlas/core/setup-validation";
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/spinner";
import { useAppContext } from "@/context/use-app-context";
import { useAuth } from "@/context/use-auth";
import { useTheme } from "@/context/use-theme";
import { client, formatError } from "@/lib/client";
import { tokenFromInviteInput } from "@/lib/invite";
import { SETUP_PATH } from "@/lib/navigation";
import { ORG_ROLE_LABELS } from "@/lib/org-roles";
import { ditherLogoSrc } from "@/lib/theme";

function resolvePostAuthPath(
  health: { providerConfigured?: boolean } | null
): string {
  if (health?.providerConfigured !== true) {
    return SETUP_PATH;
  }

  return "/chat";
}

export function InvitePage() {
  const [searchParams] = useSearchParams();
  const [tokenInput, setTokenInput] = useState(
    () => searchParams.get("token") ?? ""
  );
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [preview, setPreview] = useState<PreviewOrgInviteResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { refreshSession } = useAuth();
  const { error: healthError, health } = useAppContext();
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const token = tokenFromInviteInput(tokenInput);

  useEffect(() => {
    const nextToken = searchParams.get("token") ?? "";
    setTokenInput((current) => (current === nextToken ? current : nextToken));
  }, [searchParams]);

  useEffect(() => {
    if (!token) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);

    void client
      .previewOrgInvite(token)
      .then((next) => {
        if (!cancelled) {
          setPreview(next);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(formatError(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (health == null && !healthError) {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (health?.userConfigured === false) {
    return <Navigate replace to={SETUP_PATH} />;
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitError(null);

    if (!token) {
      setSubmitError("Invite token is required.");
      return;
    }

    const passwordError = validateSetupPassword(password, confirmPassword);
    if (passwordError) {
      setSubmitError(passwordError);
      return;
    }

    setIsSubmitting(true);
    try {
      await client.acceptOrgInvite({ password, token });
      await refreshSession();
      navigate(resolvePostAuthPath(health), { replace: true });
    } catch (err) {
      setSubmitError(formatError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-svh items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center text-center">
          <img
            alt="Atlas"
            className="mb-4 size-14 rounded-xl"
            src={ditherLogoSrc(resolvedTheme)}
          />
          <h1 className="font-semibold text-xl tracking-tight">
            Join a workspace
          </h1>
        </div>
        {healthError ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-red-800 text-sm dark:bg-red-950/30 dark:text-red-200">
            {healthError}
          </div>
        ) : null}
        {previewLoading ? (
          <div className="flex justify-center py-6">
            <Spinner className="size-6 text-muted-foreground" />
          </div>
        ) : null}
        {preview ? (
          <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-3 text-sm">
            <p className="font-medium text-foreground">{preview.orgName}</p>
            <p className="text-muted-foreground">
              {ORG_ROLE_LABELS[preview.role]}
            </p>
            <p className="font-mono text-foreground text-xs">{preview.email}</p>
          </div>
        ) : null}
        {previewError ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-red-800 text-sm dark:bg-red-950/30 dark:text-red-200">
            {previewError}
          </div>
        ) : null}
        <form
          className="space-y-4"
          onSubmit={(event) => void handleSubmit(event)}
        >
          {preview || previewLoading ? null : (
            <div>
              <label
                className="mb-1 block font-medium text-sm"
                htmlFor="invite-token"
              >
                Invite
              </label>
              <Input
                id="invite-token"
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder="Paste invite link or token"
                value={tokenInput}
              />
            </div>
          )}
          <div>
            <label
              className="mb-1 block font-medium text-sm"
              htmlFor="invite-password"
            >
              Password
            </label>
            <PasswordInput
              id="invite-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              required
              value={password}
            />
          </div>
          <div>
            <label
              className="mb-1 block font-medium text-sm"
              htmlFor="invite-confirm-password"
            >
              Confirm password
            </label>
            <PasswordInput
              id="invite-confirm-password"
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="••••••••"
              required
              value={confirmPassword}
            />
          </div>
          {submitError ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-red-800 text-sm dark:bg-red-950/30 dark:text-red-200">
              {submitError}
            </div>
          ) : null}
          <Button
            className="w-full"
            disabled={isSubmitting || !preview || previewLoading}
            size="lg"
            type="submit"
          >
            {isSubmitting ? "Joining..." : "Join workspace"}
          </Button>
        </form>
        <p className="text-center text-muted-foreground text-sm">
          <Link className="underline-offset-4 hover:underline" to="/login">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
