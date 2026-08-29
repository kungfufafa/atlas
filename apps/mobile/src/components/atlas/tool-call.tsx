import {
  CheckmarkCircle01Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { View } from "react-native";
import { ArtifactCard } from "@/components/atlas/artifact-card";
import { Text } from "@/components/ui/text";
import type { ChatListItem } from "@/features/chat/chat-items";
import { formatToolLabel, formatToolResult } from "@/features/chat/chat-items";
import { useAppTheme } from "@/features/theme/theme-provider";
import { NAV_THEME } from "@/lib/theme";

function ToolCall({
  item,
  profileId,
}: {
  item: ChatListItem;
  profileId?: string;
}) {
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;
  const running = item.toolStatus === "running";
  const result = formatToolResult(item.toolResult);

  return (
    <View className="w-full items-start">
      <View className="max-w-[80%] gap-2 rounded-[18px] rounded-bl-md bg-secondary px-3.5 py-2">
        <View className="flex-row items-center gap-2">
          <HugeiconsIcon
            color={colors.text}
            icon={running ? Loading03Icon : CheckmarkCircle01Icon}
            size={14}
          />
          <Text
            className="flex-1 text-muted-foreground text-sm"
            numberOfLines={2}
          >
            {running
              ? `Running ${item.tool ?? "tool"}`
              : formatToolLabel(item.tool, item.toolInput)}
          </Text>
        </View>
        {result ? (
          <Text
            className="font-mono text-muted-foreground text-xs"
            numberOfLines={4}
          >
            {result}
          </Text>
        ) : null}
        {item.artifacts?.map((artifact) => (
          <ArtifactCard
            artifact={artifact}
            key={artifact.id}
            profileId={profileId}
          />
        ))}
      </View>
    </View>
  );
}

export { ToolCall };
