import type { ReactNode } from "react";
import { View } from "react-native";

function InlineForm({ children }: { children: ReactNode }) {
  return (
    <View className="gap-2 border-border border-b px-4 pb-4">{children}</View>
  );
}

export { InlineForm };
