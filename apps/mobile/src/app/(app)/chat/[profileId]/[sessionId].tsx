import { Stack, useLocalSearchParams } from "expo-router";
import { ChatThread } from "@/features/chat/chat-thread";
import { displaySessionTitle } from "@/features/chat/sessions";
import { useProfilesQuery } from "@/hooks/use-profiles";
import { useSessionsQuery } from "@/hooks/use-sessions";

export default function ChatSessionScreen() {
  const params = useLocalSearchParams<{
    profileId: string;
    sessionId: string;
  }>();
  const profileId = String(params.profileId);
  const sessionId = String(params.sessionId);
  const sessionsQuery = useSessionsQuery(profileId);
  const profilesQuery = useProfilesQuery();
  const session = (sessionsQuery.data ?? []).find(
    (item) => item.id === sessionId
  );
  const profile = (profilesQuery.data ?? []).find(
    (item) => item.id === profileId
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
          title: session
            ? displaySessionTitle(session.title)
            : (profile?.name ?? "Chat"),
        }}
      />
      <ChatThread profileId={profileId} sessionId={sessionId} />
    </>
  );
}
