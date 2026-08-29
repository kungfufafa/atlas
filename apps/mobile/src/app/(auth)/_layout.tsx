import { Redirect, Stack, usePathname } from "expo-router";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/features/auth/auth-context";
import { useServer } from "@/features/server/server-context";

const AUTH_CONTINUATION_PATHS = new Set(["/connect", "/invite", "/setup"]);

export default function AuthLayout() {
  const pathname = usePathname();
  const { isReady } = useServer();
  const { isAuthenticated, isLoading } = useAuth();

  if (!isReady || isLoading) {
    return <Spinner className="flex-1 bg-background" />;
  }

  if (isAuthenticated && !AUTH_CONTINUATION_PATHS.has(pathname)) {
    return <Redirect href="/(app)/(tabs)/chats" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
