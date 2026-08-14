import { Navigate, Outlet } from "react-router-dom";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/context/use-auth";

export function WorkspaceAdminGuard() {
  const { activeOrg, isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (!(user?.isPlatformAdmin || activeOrg?.role === "admin")) {
    return <Navigate replace to="/chat" />;
  }

  return <Outlet />;
}
