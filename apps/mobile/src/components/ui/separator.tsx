import { View } from "react-native";
import { cn } from "@/lib/utils";

function Separator({ className }: { className?: string }) {
  return <View className={cn("h-px w-full bg-border", className)} />;
}

export { Separator };
