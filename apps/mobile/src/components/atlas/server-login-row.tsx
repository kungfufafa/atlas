import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useServer } from "@/features/server/server-context";
import { useAppTheme } from "@/features/theme/theme-provider";
import { NAV_THEME } from "@/lib/theme";

function ServerLoginRow({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const { activeServer } = useServer();
  const { resolved } = useAppTheme();
  const color = NAV_THEME[resolved].colors.text;

  return (
    <Pressable
      accessibilityLabel="Change server"
      className="flex-row items-center justify-between rounded-lg border border-border px-3 py-3"
      disabled={disabled}
      onPress={() => router.push("/(auth)/connect")}
    >
      <View className="min-w-0 flex-1 pr-3">
        <Text className="font-heading" numberOfLines={1}>
          {activeServer?.name ?? "Server"}
        </Text>
        {activeServer ? (
          <Text
            className="mt-1 font-mono text-muted-foreground text-xs"
            numberOfLines={1}
          >
            {activeServer.url}
          </Text>
        ) : null}
      </View>
      <HugeiconsIcon color={color} icon={ArrowRight01Icon} size={16} />
    </Pressable>
  );
}

export { ServerLoginRow };
