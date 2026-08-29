import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import {
  restoreOfflineQueryCache,
  startOfflineQueryCachePersistence,
} from "./query-cache";
import { queryClient } from "./query-client";

export function OfflineQueryCacheProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [isRestored, setIsRestored] = useState(false);

  useEffect(() => {
    let active = true;
    void restoreOfflineQueryCache(queryClient)
      .catch(() => {
        // A bad or unavailable local cache must never prevent sign-in.
      })
      .finally(() => {
        if (active) {
          setIsRestored(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isRestored) {
      return;
    }
    return startOfflineQueryCachePersistence(queryClient);
  }, [isRestored]);

  if (!isRestored) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  return children;
}
