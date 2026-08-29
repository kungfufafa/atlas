import { Redirect } from "expo-router";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/features/auth/auth-context";
import { useServer } from "@/features/server/server-context";
import { useHealthQuery } from "@/hooks/use-health";

export default function Index() {
  const { isReady, activeServer } = useServer();
  const { isAuthenticated, isLoading } = useAuth();
  const healthQuery = useHealthQuery();

  if (!isReady || isLoading || (activeServer && healthQuery.isLoading)) {
    return <Spinner className="flex-1 bg-background" />;
  }

  if (!activeServer) {
    return <Redirect href="/(auth)/login" />;
  }

  if (healthQuery.data?.userConfigured === false) {
    return <Redirect href="/(auth)/setup" />;
  }

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/login" />;
  }

  if (healthQuery.data?.providerConfigured === false) {
    return <Redirect href="/(auth)/setup" />;
  }

  return <Redirect href="/(app)/(tabs)/chats" />;
}
