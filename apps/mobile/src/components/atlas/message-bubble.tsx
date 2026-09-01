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
          "gap-2",
          isUser ? "max-w-[88%] items-end" : "w-full items-stretch"
        )}
      >
        {item.content.trim() ? (
          isUser ? (
            <View className="rounded-lg bg-secondary px-4 py-3">
              <Text
                className="text-foreground text-sm leading-[22px]"
                selectable
              >
                {item.content}
                {item.attachmentCount
                  ? `\n${item.attachmentCount} attachment${item.attachmentCount === 1 ? "" : "s"}`
                  : ""}
              </Text>
            </View>
          ) : (
            <MarkdownView
              text={item.content}
              textClassName="text-sm leading-[22px]"
            />
          )
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
