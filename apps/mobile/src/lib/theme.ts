import { atlasColors } from "@atlas/design-tokens";
import type { Theme } from "@react-navigation/native";

const fonts = {
  bold: {
    fontFamily: "InstrumentSans_700Bold",
    fontWeight: "700" as const,
  },
  heavy: {
    fontFamily: "InstrumentSans_700Bold",
    fontWeight: "800" as const,
  },
  medium: {
    fontFamily: "InstrumentSans_500Medium",
    fontWeight: "500" as const,
  },
  regular: {
    fontFamily: "InstrumentSans_400Regular",
    fontWeight: "400" as const,
  },
};

export const NAV_THEME: Record<"light" | "dark", Theme> = {
  dark: {
    colors: {
      background: atlasColors.dark.background,
      border: atlasColors.dark.border,
      card: atlasColors.dark.card,
      notification: atlasColors.dark.primary,
      primary: atlasColors.dark.primary,
      text: atlasColors.dark.foreground,
    },
    dark: true,
    fonts,
  },
  light: {
    colors: {
      background: atlasColors.light.background,
      border: atlasColors.light.border,
      card: atlasColors.light.card,
      notification: atlasColors.light.primary,
      primary: atlasColors.light.primary,
      text: atlasColors.light.foreground,
    },
    dark: false,
    fonts,
  },
};
