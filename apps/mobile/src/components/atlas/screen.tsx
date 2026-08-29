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

  return (
    <View
      className={cn("flex-1 bg-background", padded && "px-4 py-4", className)}
      style={{
        paddingBottom: edges.includes("bottom") ? insets.bottom : undefined,
        paddingLeft: edges.includes("left") ? insets.left : undefined,
        paddingRight: edges.includes("right") ? insets.right : undefined,
        paddingTop: edges.includes("top") ? insets.top : undefined,
      }}
    >
      {children}
    </View>
  );
}

export { Screen };
