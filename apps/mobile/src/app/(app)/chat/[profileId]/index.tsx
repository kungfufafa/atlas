import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { ChatThread } from "@/features/chat/chat-thread";
import { useProfilesQuery } from "@/hooks/use-profiles";

export default function NewChatScreen() {
  const params = useLocalSearchParams<{
    profileId: string;
    sessionId?: string;
  }>();
  const router = useRouter();
  const profileId = String(params.profileId);
  const sessionId =
    typeof params.sessionId === "string" ? params.sessionId : undefined;
  const profilesQuery = useProfilesQuery();
  const profile = (profilesQuery.data ?? []).find(
    (item) => item.id === profileId
  );
  const persistSessionId = useCallback(
    (createdSessionId: string) => {
      router.setParams({ sessionId: createdSessionId });
    },
    [router]
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
          title: "Chat",
        }}
      />
      <ChatThread
        onSelectProfile={(selectedProfileId) => {
          if (selectedProfileId !== profileId) {
            router.replace(`/chat/${selectedProfileId}`);
          }
        }}
        onSessionReady={persistSessionId}
        profileId={profileId}
        profileName={profile?.name}
        profiles={profilesQuery.data ?? []}
        sessionId={sessionId}
      />
    </>
  );
}
