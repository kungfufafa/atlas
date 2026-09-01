import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

function Segmented<T extends string>({
  onChange,
  options,
  value,
}: {
  onChange: (value: T) => void;
  options: Array<{ label: string; value: T }>;
  value: T;
}) {
  return (
    <View className="mx-4 mb-3 flex-row border-border border-b">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            className={cn(
              "-mb-px min-h-11 flex-1 items-center justify-center border-b-2 px-3 py-2.5",
              selected ? "border-foreground" : "border-transparent"
            )}
            key={option.value}
            onPress={() => onChange(option.value)}
          >
            <Text
              className={cn(
                "font-medium text-sm",
                selected ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export { Segmented };
