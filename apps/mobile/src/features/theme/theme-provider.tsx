import { ThemeProvider as NavigationThemeProvider } from "@react-navigation/native";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme as useSystemColorScheme, View } from "react-native";
import type { ThemePreference } from "@/lib/storage";
import { loadThemePreference, saveThemePreference } from "@/lib/storage";
import { NAV_THEME } from "@/lib/theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (theme: ThemePreference) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useSystemColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  useEffect(() => {
    void loadThemePreference().then(setPreferenceState);
  }, []);

  const resolved: "light" | "dark" =
    preference === "system"
      ? systemScheme === "dark"
        ? "dark"
        : "light"
      : preference;

  const setPreference = useCallback(async (theme: ThemePreference) => {
    setPreferenceState(theme);
    await saveThemePreference(theme);
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference]
  );

  return (
    <ThemeContext.Provider value={value}>
      <NavigationThemeProvider value={NAV_THEME[resolved]}>
        <View className={resolved === "dark" ? "dark flex-1" : "flex-1"}>
          {children}
        </View>
      </NavigationThemeProvider>
    </ThemeContext.Provider>
  );
}

export function useAppTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useAppTheme must be used within AppThemeProvider");
  }
  return value;
}
