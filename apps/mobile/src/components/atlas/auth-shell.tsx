import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Image } from "expo-image";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Screen } from "@/components/atlas/screen";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/features/theme/theme-provider";
import { NAV_THEME } from "@/lib/theme";
import { cn } from "@/lib/utils";

const LOGO = {
  dark: require("../../../assets/images/atlas-logo-dark.png"),
  light: require("../../../assets/images/atlas-logo-light.png"),
};

const GUEST_GUTTER = 16;
const GUEST_MAX_WIDTH = 480;

function AuthShell({
  children,
  footer,
  footerClassName,
  onBack,
  title,
}: {
  children: ReactNode;
  footer?: ReactNode;
  footerClassName?: string;
  onBack?: () => void;
  title: string;
}) {
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;

  return (
    <Screen edges={["top", "bottom"]}>
      <KeyboardAwareScrollView
        bottomOffset={24}
        contentContainerStyle={{
          alignItems: "center",
          flexGrow: 1,
          paddingBottom: 40,
          paddingHorizontal: GUEST_GUTTER,
          paddingTop: 12,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ maxWidth: GUEST_MAX_WIDTH, width: "100%" }}>
          {onBack ? (
            <Pressable
              accessibilityLabel="Back"
              accessibilityRole="button"
              className="mb-4 -ml-2 h-11 w-11 items-center justify-center"
              hitSlop={8}
              onPress={onBack}
            >
              <HugeiconsIcon
                color={colors.text}
                icon={ArrowLeft01Icon}
                size={22}
              />
            </Pressable>
          ) : (
            <View className="h-4" />
          )}
          <View className="items-center gap-3">
            <Image
              contentFit="contain"
              source={LOGO[resolved]}
              style={{ borderRadius: 14, height: 56, width: 56 }}
            />
            <Text className="font-heading text-2xl">{title}</Text>
          </View>
          <View className="mt-8 gap-4">{children}</View>
          {footer ? (
            <View className={cn("mt-2", footerClassName)}>{footer}</View>
          ) : null}
        </View>
      </KeyboardAwareScrollView>
    </Screen>
  );
}

export { AuthShell };
