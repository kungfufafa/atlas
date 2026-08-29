import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Pressable } from "react-native";
import { useAppTheme } from "@/features/theme/theme-provider";
import { NAV_THEME } from "@/lib/theme";

function HeaderAddButton({
  accessibilityLabel = "Add",
  onPress,
}: {
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={{
        alignItems: "center",
        height: 44,
        justifyContent: "center",
        marginRight: 4,
        width: 44,
      }}
    >
      <HugeiconsIcon color={colors.primary} icon={Add01Icon} size={22} />
    </Pressable>
  );
}

export { HeaderAddButton };
