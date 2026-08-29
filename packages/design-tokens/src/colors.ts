/** Atlas palette shared by web CSS variables and the mobile navigation theme. */
export const atlasColors = {
  dark: {
    background: "#0a0a0b",
    border: "#27272a",
    card: "#18181b",
    foreground: "#fafafa",
    muted: "#1f1f23",
    mutedForeground: "#a1a1aa",
    primary: "#2563eb",
    primaryForeground: "#0a0a0b",
  },
  light: {
    background: "#ffffff",
    border: "#e5e5e5",
    card: "#ffffff",
    foreground: "#171717",
    muted: "#f5f5f5",
    mutedForeground: "#737373",
    primary: "#2563eb",
    primaryForeground: "#ffffff",
  },
} as const;

export type AtlasColorScheme = keyof typeof atlasColors;
