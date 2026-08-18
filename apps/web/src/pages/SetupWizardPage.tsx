import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { SetupLayout } from "@/components/SetupLayout";
import { SetupWizard } from "@/components/setup-wizard/SetupWizard";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAppContext } from "@/context/use-app-context";
import { useAuth } from "@/context/use-auth";
import { useTheme } from "@/context/use-theme";
import { pathForPage, SETUP_PATH } from "@/lib/navigation";
import { canCompleteWorkspaceSetup } from "@/lib/org-roles";
import { ditherLogoSrc } from "@/lib/theme";

function SetupWaiting({ onSignOut }: { onSignOut: () => void }) {
  const { resolvedTheme } = useTheme();

  return (
    <div className="flex h-svh items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 text-center">
        <img
          alt="Atlas"
          className="mx-auto size-14 rounded-xl"
          src={ditherLogoSrc(resolvedTheme)}
        />
        <h1 className="font-semibold text-xl tracking-tight">
          Waiting for setup
        </h1>
        <p className="text-muted-foreground text-sm">
          A Workspace Admin still needs to finish configuring this workspace.
        </p>
        <Button onClick={onSignOut} type="button" variant="outline">
          Sign out
        </Button>
      </div>
    </div>
  );
}

export function SetupWizardPage() {
  const { health, loading } = useAppContext();
  const {
    activeOrg,
    isAuthenticated,
    isLoading: authLoading,
    logout,
    user,
  } = useAuth();
  const [wizardInProgress, setWizardInProgress] = useState(false);

  const isFullyConfigured =
    health?.userConfigured === true && health?.providerConfigured === true;
  const canFinishSetup = canCompleteWorkspaceSetup(
    user?.isPlatformAdmin === true,
    activeOrg?.role
  );

  // Allow finishing the wizard when setup flags flip true mid-flow (e.g. step 4
  // after provider is configured on step 3), but block fresh visits once done.
  useEffect(() => {
    if (health != null && !isFullyConfigured) {
      setWizardInProgress(true);
    }
  }, [health, isFullyConfigured]);

  if (loading || authLoading) {
    return (
      <SetupLayout>
        <div className="flex justify-center py-16">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      </SetupLayout>
    );
  }

  // Account/org already exist — provider setup needs an authenticated session.
  if (health?.userConfigured === true && !isAuthenticated) {
    return <Navigate replace state={{ from: SETUP_PATH }} to="/login" />;
  }

  if (isAuthenticated && !canFinishSetup) {
    if (isFullyConfigured) {
      return <Navigate replace to={pathForPage("chat")} />;
    }

    return (
      <SetupWaiting
        onSignOut={() => {
          void logout();
        }}
      />
    );
  }

  if (isFullyConfigured && !wizardInProgress) {
    return <Navigate replace to={pathForPage("chat")} />;
  }

  return (
    <SetupLayout>
      <SetupWizard />
    </SetupLayout>
  );
}
