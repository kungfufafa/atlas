import NetInfo from "@react-native-community/netinfo";
import {
  focusManager,
  onlineManager,
  QueryClient,
} from "@tanstack/react-query";
import { AppState } from "react-native";
import { isNetworkOnline } from "@/features/network/network-status";

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let mobileLifecycleConfigured = false;

export function configureMobileQueryLifecycle(): void {
  if (mobileLifecycleConfigured) {
    return;
  }
  mobileLifecycleConfigured = true;

  onlineManager.setEventListener((setOnline) => {
    const updateOnlineState = (isConnected: boolean | null | undefined) => {
      setOnline(isNetworkOnline(isConnected));
    };
    const unsubscribe = NetInfo.addEventListener((state) => {
      updateOnlineState(state.isConnected);
    });

    void NetInfo.fetch()
      .then((state) => {
        updateOnlineState(state.isConnected);
      })
      .catch(() => {
        setOnline(false);
      });

    return unsubscribe;
  });

  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener("change", (state) => {
      setFocused(state === "active");
    });
    return () => subscription.remove();
  });
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: ONE_WEEK_MS,
      refetchOnReconnect: "always",
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
