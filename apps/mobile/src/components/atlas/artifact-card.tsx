import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import type { ChatArtifact } from "@/features/chat/chat-items";
import { formatBytes } from "@/features/chat/chat-items";
import { useAppTheme } from "@/features/theme/theme-provider";
import { displayFileKind } from "@/lib/file-display";
import { NAV_THEME } from "@/lib/theme";

function ArtifactCard({
  artifact,
  profileId,
}: {
  artifact: ChatArtifact;
  profileId?: string;
}) {
  const router = useRouter();
  const { resolved } = useAppTheme();
  const color = NAV_THEME[resolved].colors.text;

  const open = () => {
    if (!profileId) {
      return;
    }
    router.push({
      params: { path: artifact.path, profileId },
      pathname: "/artifact",
    });
  };

  return (
    <Pressable
      accessibilityRole={profileId ? "button" : undefined}
      className="flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
      disabled={!profileId}
      onPress={open}
    >
      <HugeiconsIcon color={color} icon={File01Icon} size={18} />
      <View className="flex-1">
        <Text className="font-medium" numberOfLines={1}>
          {artifact.filename}
        </Text>
        <Text className="text-muted-foreground text-xs">
          {displayFileKind(artifact.filename, artifact.mimeType)}
          {artifact.size > 0 ? ` · ${formatBytes(artifact.size)}` : ""}
        </Text>
      </View>
    </Pressable>
  );
}

export { ArtifactCard };
