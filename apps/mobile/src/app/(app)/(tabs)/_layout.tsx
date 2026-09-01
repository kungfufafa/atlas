import {
  Chat01Icon,
  Folder01Icon,
  Menu01Icon,
  Task01Icon,
  UserSquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Tabs } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "@/features/theme/theme-provider";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";
import { NAV_THEME } from "@/lib/theme";

export default function TabsLayout() {
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;
  const insets = useSafeAreaInsets();
  const { canAccessFiles, canAccessProfiles, canMutate } = useWorkspaceAccess();
  const bottomInset = Math.max(insets.bottom, 8);

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          headerTitleStyle: { fontFamily: "InstrumentSans_600SemiBold" },
          tabBarActiveTintColor: colors.primary,
          tabBarHideOnKeyboard: true,
          tabBarInactiveTintColor: colors.text,
          tabBarLabelStyle: {
            fontFamily: "InstrumentSans_500Medium",
            fontSize: 10,
          },
          tabBarStyle: {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            height: 54 + bottomInset,
            paddingBottom: bottomInset,
            paddingTop: 4,
          },
        }}
      >
        <Tabs.Screen
          name="chats"
          options={{
            tabBarIcon: ({ color, size }) => (
              <HugeiconsIcon color={color} icon={Chat01Icon} size={size} />
            ),
            title: "Chats",
          }}
        />
        <Tabs.Screen
          name="files"
          options={{
            href: canAccessFiles ? undefined : null,
            tabBarIcon: ({ color, size }) => (
              <HugeiconsIcon color={color} icon={Folder01Icon} size={size} />
            ),
            title: "Files",
          }}
        />
        <Tabs.Screen
          name="agents"
          options={{
            href: canAccessProfiles ? undefined : null,
            tabBarIcon: ({ color, size }) => (
              <HugeiconsIcon color={color} icon={UserSquareIcon} size={size} />
            ),
            title: "Profiles",
          }}
        />
        <Tabs.Screen
          name="work"
          options={{
            href: canMutate ? undefined : null,
            tabBarIcon: ({ color, size }) => (
              <HugeiconsIcon color={color} icon={Task01Icon} size={size} />
            ),
            tabBarLabel: "Work",
            title: "Agent work",
          }}
        />
        <Tabs.Screen
          name="more"
          options={{
            tabBarIcon: ({ color, size }) => (
              <HugeiconsIcon color={color} icon={Menu01Icon} size={size} />
            ),
            title: "More",
          }}
        />
      </Tabs>
    </View>
  );
}
