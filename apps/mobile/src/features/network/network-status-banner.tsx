import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/ui/text";
import { useNetwork } from "@/features/network/network-context";

export function NetworkStatusBanner() {
  const { isOffline } = useNetwork();
  const insets = useSafeAreaInsets();

  if (!isOffline) {
    return null;
  }

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      className="bg-amber-400 px-4 pb-2"
      style={{ paddingTop: insets.top + 8 }}
    >
      <Text className="text-center font-medium text-amber-950 text-sm">
        You’re offline. Showing saved data; messages and changes are paused.
      </Text>
    </View>
  );
}
