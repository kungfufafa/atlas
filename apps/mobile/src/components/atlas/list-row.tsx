import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/features/theme/theme-provider";
import { NAV_THEME } from "@/lib/theme";

function ListRow({
  onPress,
  right,
  showChevron,
  subtitle,
  title,
  value,
}: {
  onPress?: () => void;
  right?: ReactNode;
  showChevron?: boolean;
  subtitle?: string | null;
  title: string;
  value?: string | null;
}) {
  const { resolved } = useAppTheme();
  const color = NAV_THEME[resolved].colors.text;
  const chevron = showChevron ?? Boolean(onPress && !right);

  return (
    <Pressable
      className="flex-row items-center border-border border-b px-4 py-3"
      disabled={!onPress}
      onPress={onPress}
    >
      <View className="min-w-0 flex-1 pr-3">
        <Text className="font-heading" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text
            className="mt-1 text-muted-foreground text-sm"
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text className="text-muted-foreground text-sm" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {chevron ? (
        <HugeiconsIcon color={color} icon={ArrowRight01Icon} size={16} />
      ) : null}
    </Pressable>
  );
}

export { ListRow };
