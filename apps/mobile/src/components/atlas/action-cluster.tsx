import type { ReactNode } from "react";
import { View } from "react-native";

function ActionCluster({ children }: { children: ReactNode }) {
  return <View className="flex-row flex-wrap gap-2">{children}</View>;
}

export { ActionCluster };
