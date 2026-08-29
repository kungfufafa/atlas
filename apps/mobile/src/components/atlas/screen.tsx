import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "@/lib/utils";

function Screen({
  children,
  className,
  edges = [],
  padded = false,
}: {
  children: ReactNode;
  className?: string;
  edges?: ("top" | "bottom" | "left" | "right")[];
  padded?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const safeAreaPadding = {
    ...(edges.includes("bottom") ? { paddingBottom: insets.bottom } : {}),
    ...(edges.includes("left") ? { paddingLeft: insets.left } : {}),
    ...(edges.includes("right") ? { paddingRight: insets.right } : {}),
    ...(edges.includes("top") ? { paddingTop: insets.top } : {}),
  };

  return (
    <View
      className={cn("flex-1 bg-background", padded && "px-4 py-4", className)}
      style={safeAreaPadding}
    >
      {children}
    </View>
  );
}

export { Screen };
