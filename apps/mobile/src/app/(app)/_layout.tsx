import { Redirect, Stack } from "expo-router";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/features/auth/auth-context";
import { useServer } from "@/features/server/server-context";
import { useAppTheme } from "@/features/theme/theme-provider";
import { NAV_THEME } from "@/lib/theme";

export default function AppLayout() {
  const { isReady, activeServer } = useServer();
  const { isAuthenticated, isLoading } = useAuth();
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;

  if (!isReady || isLoading) {
    return <Spinner className="flex-1 bg-background" />;
  }

  if (!activeServer) {
    return <Redirect href="/(auth)/login" />;
  }

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: colors.background },
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: "InstrumentSans_600SemiBold" },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
