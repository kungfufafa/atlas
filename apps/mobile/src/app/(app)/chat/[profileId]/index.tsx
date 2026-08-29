import { Stack, useLocalSearchParams } from "expo-router";
import { ChatThread } from "@/features/chat/chat-thread";
import { useProfilesQuery } from "@/hooks/use-profiles";

export default function NewChatScreen() {
  const params = useLocalSearchParams<{ profileId: string }>();
  const profileId = String(params.profileId);
  const profilesQuery = useProfilesQuery();
  const profile = (profilesQuery.data ?? []).find(
    (item) => item.id === profileId
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: profile?.name ?? "New chat",
        }}
      />
      <ChatThread profileId={profileId} />
    </>
  );
}
