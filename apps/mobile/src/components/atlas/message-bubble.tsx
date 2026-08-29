import { View } from "react-native";
import { ArtifactCard } from "@/components/atlas/artifact-card";
import { MarkdownView } from "@/components/atlas/markdown";
import { Text } from "@/components/ui/text";
import type { ChatListItem } from "@/features/chat/chat-items";
import { cn } from "@/lib/utils";

function MessageBubble({
  item,
  profileId,
}: {
  item: ChatListItem;
  profileId?: string;
}) {
  const isUser = item.role === "user";

  return (
    <View className={cn("w-full", isUser ? "items-end" : "items-start")}>
      <View
        className={cn(
          "max-w-[80%] gap-2",
          isUser ? "items-end" : "items-start"
        )}
      >
        {item.content.trim() ? (
          <View
            className={cn("px-4 py-2", isUser ? "bg-primary" : "bg-secondary")}
            style={{
              borderBottomLeftRadius: isUser ? 20 : 6,
              borderBottomRightRadius: isUser ? 6 : 20,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
            }}
          >
            {isUser ? (
              <Text className="text-primary-foreground" selectable>
                {item.content}
                {item.attachmentCount
                  ? `\n${item.attachmentCount} attachment${item.attachmentCount === 1 ? "" : "s"}`
                  : ""}
              </Text>
            ) : (
              <MarkdownView text={item.content} />
            )}
          </View>
        ) : item.streaming ? (
          <Text className="px-1 text-muted-foreground text-sm">Thinking…</Text>
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

export { MessageBubble };
