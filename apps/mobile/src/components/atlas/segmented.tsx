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
    <View className="mx-4 mb-3 flex-row rounded-full bg-secondary p-1">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            className={cn(
              "min-h-9 flex-1 items-center justify-center rounded-full py-2",
              selected && "bg-primary"
            )}
            key={option.value}
            onPress={() => onChange(option.value)}
          >
            <Text
              className={
                selected ? "font-medium text-primary-foreground" : "font-medium"
              }
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
