import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/features/theme/theme-provider";
import { NAV_THEME } from "@/lib/theme";

function SectionHeading({
  onAdd,
  title,
}: {
  onAdd?: () => void;
  title: string;
}) {
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;

  return (
    <View className="flex-row items-center justify-between px-4 pt-5 pb-2">
      <Text className="font-heading">{title}</Text>
      {onAdd ? (
        <Pressable
          accessibilityLabel={`Add ${title}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onAdd}
        >
          <HugeiconsIcon color={colors.primary} icon={Add01Icon} size={18} />
        </Pressable>
      ) : null}
    </View>
  );
}

export { SectionHeading };
