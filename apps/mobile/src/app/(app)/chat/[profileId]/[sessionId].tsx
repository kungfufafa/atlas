import { Stack, useLocalSearchParams } from "expo-router";
import { ChatThread } from "@/features/chat/chat-thread";
import { displaySessionTitle } from "@/features/chat/sessions";
import { useSessionsQuery } from "@/hooks/use-sessions";

export default function ChatSessionScreen() {
  const params = useLocalSearchParams<{
    profileId: string;
    sessionId: string;
  }>();
  const profileId = String(params.profileId);
  const sessionId = String(params.sessionId);
  const sessionsQuery = useSessionsQuery(profileId);
  const session = (sessionsQuery.data ?? []).find(
    (item) => item.id === sessionId
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTitleStyle: {
            fontFamily: "InstrumentSans_600SemiBold",
            fontSize: 17,
          },
          title: session?.title?.trim()
            ? displaySessionTitle(session.title)
            : "Chat",
        }}
      />
      <ChatThread profileId={profileId} sessionId={sessionId} />
    </>
  );
}
