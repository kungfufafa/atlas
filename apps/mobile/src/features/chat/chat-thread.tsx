import type { ProfileSummary } from "@atlas/core/contract";
import type { FlashListRef } from "@shopify/flash-list";
import { useEffect, useRef } from "react";
import { Pressable, ScrollView, View } from "react-native";
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
import { settledSessionIdToPersist } from "@/features/chat/chat-navigation";
import { useChatSession } from "@/features/chat/use-chat-session";
import { useNetwork } from "@/features/network/network-context";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";
import { cn } from "@/lib/utils";

function ChatRow({
  first,
  grouped,
  item,
  onRetry,
  profileId,
  retryDisabled,
}: {
  first: boolean;
  grouped: boolean;
  item: ChatListItem;
  onRetry?: (message: ChatListItem) => void;
  profileId: string;
  retryDisabled: boolean;
}) {
  return (
    <View className={cn("w-full", first ? "mt-0" : grouped ? "mt-1" : "mt-6")}>
      {item.failed ? (
        <View
          accessibilityRole="alert"
          className="max-w-[90%] gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5"
        >
          <View className="gap-1">
            <Text className="font-medium text-destructive text-xs">Failed</Text>
            <Text className="text-destructive text-sm">
              {item.content || "The model did not respond."}
            </Text>
          </View>
          {onRetry ? (
            <Pressable
              accessibilityLabel="Retry failed message"
              accessibilityRole="button"
              className={cn(
                "h-9 flex-row items-center self-start rounded-lg border border-destructive/30 bg-background px-3",
                retryDisabled && "opacity-50"
              )}
              disabled={retryDisabled}
              onPress={() => onRetry(item)}
            >
              <Text className="font-medium text-destructive text-sm">
                Retry
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : item.role === "tool" ? (
        <ToolCall item={item} profileId={profileId} />
      ) : (
        <MessageBubble item={item} profileId={profileId} />
      )}
    </View>
  );
}

function greetingForHour(hour: number): string {
  if (hour < 12) {
    return "Hi, good morning!";
  }
  if (hour < 18) {
    return "Hi, good afternoon!";
  }
  return "Hi, good evening!";
}

function ChatWelcome({
  onSelectProfile,
  profileId,
  profileName,
  profiles,
}: {
  onSelectProfile?: (profileId: string) => void;
  profileId: string;
  profileName?: string;
  profiles: readonly Pick<ProfileSummary, "id" | "name">[];
}) {
  return (
    <View className="gap-2 px-4 pb-2">
      <Text className="font-heading text-xl tracking-tight">
        {greetingForHour(new Date().getHours())}
      </Text>
      <View className="flex-row items-center gap-2">
        <Text className="shrink-0 text-muted-foreground text-sm">
          Select profile
        </Text>
        {profiles.length > 0 ? (
          <ScrollView
            className="min-w-0 flex-1"
            contentContainerClassName="gap-2"
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            <View accessibilityRole="radiogroup" className="flex-row gap-2">
              {profiles.map((profile) => {
                const selected = profile.id === profileId;
                return (
                  <Pressable
                    accessibilityLabel={profile.name}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    className={cn(
                      "min-h-11 justify-center rounded-full border border-border px-3",
                      selected && "border-foreground bg-accent"
                    )}
                    key={profile.id}
                    onPress={() => onSelectProfile?.(profile.id)}
                  >
                    <Text className="text-sm">{profile.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        ) : (
          <View className="min-h-11 justify-center rounded-full border border-foreground bg-accent px-3">
            <Text className="text-sm">{profileName ?? "Agent"}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

export function ChatThread({
  onSelectProfile,
  onSessionReady,
  profileId,
  profileName,
  profiles = [],
  sessionId,
}: {
  onSelectProfile?: (profileId: string) => void;
  onSessionReady?: (sessionId: string) => void;
  profileId: string;
  profileName?: string;
  profiles?: readonly Pick<ProfileSummary, "id" | "name">[];
  sessionId?: string;
}) {
  const insets = useSafeAreaInsets();
  const { canMutate } = useWorkspaceAccess();
  const { isOffline } = useNetwork();
  const listRef = useRef<FlashListRef<ChatListItem>>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const {
    activeSessionId,
    decideApproval,
    error,
    isLoading,
    isSending,
    messages,
    relatedQuestions,
    retry,
    send,
    stop,
    todos,
  } = useChatSession(profileId, sessionId);
  const pendingApproval = pendingApprovalFromMessages(messages);
  const showWelcome = !sessionId && messages.length === 0 && !isSending;

  useEffect(() => {
    const settledSessionId = settledSessionIdToPersist({
      activeSessionId,
      currentSessionId: sessionId,
      isSending,
    });
    if (settledSessionId) {
      onSessionReady?.(settledSessionId);
    }
  }, [activeSessionId, isSending, onSessionReady, sessionId]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const scrollView = listRef.current?.getNativeScrollRef?.();
      scrollView?.scrollToEnd({ animated: !isSending });
    });
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [isSending, messages]);

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
      {showWelcome ? (
        <View className="flex-1 justify-center pb-12">
          <View className="gap-1">
            <ChatWelcome
              onSelectProfile={onSelectProfile}
              profileId={profileId}
              profileName={profileName}
              profiles={profiles}
            />
            <ChatComposer
              disabled={!canMutate || isOffline}
              isSending={isSending}
              onSend={send}
              onStop={stop}
              sticky={false}
            />
            {error ? (
              <Text className="px-4 text-destructive text-sm">{error}</Text>
            ) : null}
          </View>
        </View>
      ) : (
        <>
          <FlexFlashList
            contentContainerStyle={{
              paddingBottom: 16,
              paddingHorizontal: 20,
              paddingTop: 16,
            }}
            data={messages}
            keyExtractor={(item) => item.id}
            ref={listRef}
            renderItem={({ item, index }) => (
              <ChatRow
                first={index === 0}
                grouped={
                  index > 0 &&
                  messages[index - 1]?.role === item.role &&
                  item.role !== "tool"
                }
                item={item}
                onRetry={canMutate ? retry : undefined}
                profileId={profileId}
                retryDisabled={isOffline || isSending}
              />
            )}
          />
          {relatedQuestions.length > 0 && canMutate ? (
            <View className="gap-1 px-5 pb-2">
              {relatedQuestions.map((question) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isOffline }}
                  className={cn(
                    "min-h-11 justify-center rounded-md px-2 py-2",
                    isOffline && "opacity-40"
                  )}
                  disabled={isOffline}
                  key={question}
                  onPress={() => {
                    void send({ message: question });
                  }}
                >
                  <Text className="text-muted-foreground text-sm leading-5">
                    {question}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {error ? (
            <Text className="px-5 pb-2 text-destructive text-sm">{error}</Text>
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
        </>
      )}
    </View>
  );
}
