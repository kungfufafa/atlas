import type { FlashListRef } from "@shopify/flash-list";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApprovalCard } from "@/components/atlas/approval-card";
import { ChatComposer } from "@/components/atlas/chat-composer";
import { FlexFlashList } from "@/components/atlas/flex-list";
import { MessageBubble } from "@/components/atlas/message-bubble";
import { ToolCall } from "@/components/atlas/tool-call";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { ChatListItem } from "@/features/chat/chat-items";
import { pendingApprovalFromMessages } from "@/features/chat/chat-items";
import { useChatSession } from "@/features/chat/use-chat-session";
import { useNetwork } from "@/features/network/network-context";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";
import { cn } from "@/lib/utils";

function ChatRow({
  grouped,
  item,
  profileId,
}: {
  grouped: boolean;
  item: ChatListItem;
  profileId: string;
}) {
  return (
    <View className={cn("w-full", grouped ? "mt-1" : "mt-2.5")}>
      {item.role === "tool" ? (
        <ToolCall item={item} profileId={profileId} />
      ) : (
        <MessageBubble item={item} profileId={profileId} />
      )}
    </View>
  );
}

export function ChatThread({
  profileId,
  sessionId,
}: {
  profileId: string;
  sessionId?: string;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { canMutate } = useWorkspaceAccess();
  const { isOffline } = useNetwork();
  const listRef = useRef<FlashListRef<ChatListItem>>(null);
  const {
    activeSessionId,
    decideApproval,
    error,
    isLoading,
    isSending,
    messages,
    relatedQuestions,
    send,
    stop,
    todos,
  } = useChatSession(profileId, sessionId);
  const pendingApproval = pendingApprovalFromMessages(messages);

  useEffect(() => {
    if (activeSessionId && activeSessionId !== sessionId) {
      router.replace(`/chat/${profileId}/${activeSessionId}`);
    }
  }, [activeSessionId, profileId, router, sessionId]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    requestAnimationFrame(() => {
      const scrollView = listRef.current?.getNativeScrollRef?.();
      scrollView?.scrollToEnd({ animated: true });
    });
  }, [messages]);

  if (isLoading) {
    return <Spinner className="flex-1 bg-background" />;
  }

  return (
    <View className="flex-1 bg-background">
      {todos.length > 0 ? (
        <View className="border-border border-b px-4 py-2">
          {todos.map((todo) => (
            <Text className="text-sm" key={todo.id} numberOfLines={1}>
              {todo.status === "completed" ? "✓ " : "○ "}
              {todo.content}
            </Text>
          ))}
        </View>
      ) : null}
      <FlexFlashList
        contentContainerStyle={{
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
        data={messages}
        keyExtractor={(item) => item.id}
        ref={listRef}
        renderItem={({ item, index }) => (
          <ChatRow
            grouped={
              index > 0 &&
              messages[index - 1]?.role === item.role &&
              item.role !== "tool"
            }
            item={item}
            profileId={profileId}
          />
        )}
      />
      {relatedQuestions.length > 0 && canMutate ? (
        <View className="flex-row flex-wrap gap-2 px-3 pb-2">
          {relatedQuestions.map((question) => (
            <Pressable
              className="rounded-full bg-secondary px-3 py-2"
              disabled={isOffline}
              key={question}
              onPress={() => {
                void send({ message: question });
              }}
            >
              <Text className="text-sm">{question}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? (
        <Text className="px-4 pb-2 text-destructive text-sm">{error}</Text>
      ) : null}
      {pendingApproval ? (
        <ApprovalCard
          approval={pendingApproval}
          onDecide={decideApproval}
          readOnly={!canMutate}
        />
      ) : null}
      <View style={{ paddingBottom: insets.bottom }}>
        <ChatComposer
          disabled={!canMutate || isOffline}
          isSending={isSending}
          onSend={send}
          onStop={stop}
        />
      </View>
    </View>
  );
}
