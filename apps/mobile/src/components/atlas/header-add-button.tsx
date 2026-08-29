import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { ActivityIndicator, Pressable } from "react-native";
import { useAppTheme } from "@/features/theme/theme-provider";
import { NAV_THEME } from "@/lib/theme";

function HeaderAddButton({
  accessibilityLabel = "Add",
  disabled = false,
  onPress,
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;
  const canPress = !disabled;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      hitSlop={8}
      onPress={() => {
        if (canPress) {
          onPress();
        }
      }}
      style={{
        alignItems: "center",
        height: 44,
        justifyContent: "center",
        marginRight: 4,
        opacity: disabled ? 0.45 : 1,
        width: 44,
      }}
    >
      {disabled ? (
        <ActivityIndicator color={colors.primary} size="small" />
      ) : (
        <HugeiconsIcon color={colors.primary} icon={Add01Icon} size={22} />
      )}
    </Pressable>
  );
}

export { HeaderAddButton };
