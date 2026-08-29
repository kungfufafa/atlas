import { ActivityIndicator, View } from "react-native";
import { cn } from "@/lib/utils";

function Spinner({ className }: { className?: string }) {
  return (
    <View className={cn("items-center justify-center p-6", className)}>
      <ActivityIndicator />
    </View>
  );
}

export { Spinner };
