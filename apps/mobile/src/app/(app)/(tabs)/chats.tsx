import { useNavigation, useRouter } from "expo-router";
import { useCallback, useLayoutEffect, useState } from "react";
import { View } from "react-native";
import { EmptyState } from "@/components/atlas/empty-state";
import { FlexFlashList } from "@/components/atlas/flex-list";
import { HeaderAddButton } from "@/components/atlas/header-add-button";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import {
  displaySessionPreview,
  displaySessionTitle,
} from "@/features/chat/sessions";
import { useProfilesQuery } from "@/hooks/use-profiles";
import { useAllSessionsQuery } from "@/hooks/use-workspace";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";

export default function ChatsScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { canMutate } = useWorkspaceAccess();
  const profilesQuery = useProfilesQuery();
  const sessionsQuery = useAllSessionsQuery();
  const profiles = profilesQuery.data ?? [];
  const [pickingAgent, setPickingAgent] = useState(false);
  const profileName = new Map(
    profiles.map((profile) => [profile.id, profile.name])
  );

  const startNewChat = useCallback(() => {
    if (profiles.length === 1 && profiles[0]) {
      router.push(`/chat/${profiles[0].id}`);
      return;
    }
    setPickingAgent((current) => !current);
  }, [profiles, router]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight:
        canMutate && profiles.length > 0
          ? () => (
              <HeaderAddButton
                accessibilityLabel="New chat"
                onPress={startNewChat}
              />
            )
          : undefined,
    });
  }, [canMutate, navigation, profiles.length, startNewChat]);

  return (
    <QueryState
      error={profilesQuery.error ?? sessionsQuery.error}
      loading={profilesQuery.isLoading || sessionsQuery.isLoading}
      onRetry={() => {
        void profilesQuery.refetch();
        void sessionsQuery.refetch();
      }}
    >
      <Screen>
        <FlexFlashList
          contentContainerStyle={{ paddingBottom: 16 }}
          data={sessionsQuery.data ?? []}
          keyExtractor={(item) => `${item.profileId}:${item.id}`}
          ListEmptyComponent={<EmptyState message="No chats yet." />}
          ListHeaderComponent={
            pickingAgent ? (
              <View>
                {profiles.map((profile) => (
                  <ListRow
                    key={profile.id}
                    onPress={() => {
                      setPickingAgent(false);
                      router.push(`/chat/${profile.id}`);
                    }}
                    title={profile.name}
                  />
                ))}
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <ListRow
              onPress={() => router.push(`/chat/${item.profileId}/${item.id}`)}
              subtitle={
                [
                  profileName.get(item.profileId),
                  displaySessionPreview(item.preview),
                ]
                  .filter(Boolean)
                  .join(" · ") || null
              }
              title={displaySessionTitle(item.title)}
            />
          )}
        />
      </Screen>
    </QueryState>
  );
}
