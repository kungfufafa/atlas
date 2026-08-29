import "../ignore-logs";
import "@/global.css";

import { PortalHost } from "@rn-primitives/portal";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AuthProvider } from "@/features/auth/auth-context";
import { NetworkProvider } from "@/features/network/network-context";
import { NetworkStatusBanner } from "@/features/network/network-status-banner";
import { ServerProvider, useServer } from "@/features/server/server-context";
import { ServerQueryCacheBoundary } from "@/features/server/server-query-cache";
import { AppThemeProvider, useAppTheme } from "@/features/theme/theme-provider";
import { useAppFonts } from "@/hooks/use-app-fonts";
import { OfflineQueryCacheProvider } from "@/lib/query-cache-provider";
import { configureMobileQueryLifecycle, queryClient } from "@/lib/query-client";

SplashScreen.preventAutoHideAsync();

function ThemedStatusBar() {
  const { resolved } = useAppTheme();
  return <StatusBar style={resolved === "dark" ? "light" : "dark"} />;
}

function ServerScopedNavigation() {
  const { activeServer } = useServer();

  return (
    <AuthProvider key={activeServer?.id ?? "no-server"}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>
      <PortalHost />
    </AuthProvider>
  );
}

export default function RootLayout() {
  const fontsLoaded = useAppFonts();

  useEffect(() => {
    configureMobileQueryLifecycle();
  }, []);

  useEffect(() => {
    if (fontsLoaded) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <OfflineQueryCacheProvider>
            <NetworkProvider>
              <ServerProvider>
                <ServerQueryCacheBoundary>
                  <AppThemeProvider>
                    <View className="flex-1">
                      <ThemedStatusBar />
                      <NetworkStatusBanner />
                      <ServerScopedNavigation />
                    </View>
                  </AppThemeProvider>
                </ServerQueryCacheBoundary>
              </ServerProvider>
            </NetworkProvider>
          </OfflineQueryCacheProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
