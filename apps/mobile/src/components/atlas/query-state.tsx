import type { ReactNode } from "react";
import { View } from "react-native";
import { Screen } from "@/components/atlas/screen";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useNetwork } from "@/features/network/network-context";

function QueryState({
  children,
  error,
  loading,
  onRetry,
}: {
  children: ReactNode;
  error: unknown;
  loading: boolean;
  onRetry?: () => void;
}) {
  const { isOffline } = useNetwork();
  if (loading) {
    return (
      <Screen className="items-center justify-center">
        <Spinner />
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen className="items-center justify-center">
        <View className="items-center gap-3">
          <Text className="text-center text-destructive">
            {isOffline
              ? "You're offline. Reconnect to load this page."
              : "Could not load this page."}
          </Text>
          {onRetry ? (
            <Button onPress={onRetry} size="sm" variant="outline">
              <Text>Try again</Text>
            </Button>
          ) : null}
        </View>
      </Screen>
    );
  }

  return children;
}

export { QueryState };
