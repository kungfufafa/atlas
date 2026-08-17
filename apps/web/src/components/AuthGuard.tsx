import { Navigate, Outlet } from "react-router-dom";
import { Spinner } from "@/components/ui/spinner";
import { useAppContext } from "@/context/use-app-context";
import { useAuth } from "@/context/use-auth";
import { SETUP_PATH } from "@/lib/navigation";

export function AuthGuard() {
  const { isAuthenticated, isLoading } = useAuth();
  const { error: healthError, health } = useAppContext();

  if (isLoading || (health == null && !healthError)) {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (health?.userConfigured === false) {
    return <Navigate replace to={SETUP_PATH} />;
  }

  if (!isAuthenticated) {
    return <Navigate replace to="/login" />;
  }

  return <Outlet />;
}
