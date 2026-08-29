import { View } from "react-native";
import { Text } from "@/components/ui/text";

function EmptyState({ message }: { message: string }) {
  return (
    <View className="px-4 py-10">
      <Text className="text-center text-muted-foreground">{message}</Text>
    </View>
  );
}

export { EmptyState };
