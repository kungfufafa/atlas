import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ChatThread } from "@/features/chat/chat-thread";
import { useProfilesQuery } from "@/hooks/use-profiles";

export default function NewChatScreen() {
  const params = useLocalSearchParams<{ profileId: string }>();
  const router = useRouter();
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
        profileId={profileId}
        profileName={profile?.name}
        profiles={profilesQuery.data ?? []}
      />
    </>
  );
}
