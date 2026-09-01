import { useNavigation, useRouter } from "expo-router";
import { useCallback, useLayoutEffect, useMemo } from "react";
import { EmptyState } from "@/components/atlas/empty-state";
import { FlexFlashList } from "@/components/atlas/flex-list";
import { HeaderAddButton } from "@/components/atlas/header-add-button";
import { ListRow } from "@/components/atlas/list-row";
import { ProfileSelector } from "@/components/atlas/profile-selector";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import {
  displaySessionPreview,
  displaySessionTitle,
} from "@/features/chat/sessions";
import { useActiveProfileSelection } from "@/hooks/use-active-profile-selection";
import { useProfilesQuery } from "@/hooks/use-profiles";
import { useAllSessionsQuery } from "@/hooks/use-workspace";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";
import { filterProfileScopedItems } from "@/lib/profile-selection";

export default function ChatsScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { canMutate } = useWorkspaceAccess();
  const profilesQuery = useProfilesQuery();
  const sessionsQuery = useAllSessionsQuery();
  const profiles = profilesQuery.data ?? [];
  const { isLoading, selectProfile, selectedProfileId } =
    useActiveProfileSelection(profilesQuery.data);
  const selectedProfile = profiles.find(
    (profile) => profile.id === selectedProfileId
  );
  const sessions = useMemo(
    () => filterProfileScopedItems(sessionsQuery.data ?? [], selectedProfileId),
    [selectedProfileId, sessionsQuery.data]
  );

  const startNewChat = useCallback(() => {
    if (selectedProfileId) {
      router.push(`/chat/${selectedProfileId}`);
    }
  }, [router, selectedProfileId]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight:
        canMutate && selectedProfileId
          ? () => (
              <HeaderAddButton
                accessibilityLabel="New chat"
                onPress={startNewChat}
              />
            )
          : undefined,
    });
  }, [canMutate, navigation, selectedProfileId, startNewChat]);

  return (
    <QueryState
      error={profilesQuery.error ?? sessionsQuery.error}
      loading={profilesQuery.isLoading || sessionsQuery.isLoading || isLoading}
      onRetry={() => {
        void profilesQuery.refetch();
        void sessionsQuery.refetch();
      }}
    >
      <Screen>
        <ProfileSelector
          onSelect={selectProfile}
          profiles={profiles}
          selectedProfileId={selectedProfileId}
        />
        <FlexFlashList
          contentContainerStyle={{ paddingBottom: 16 }}
          data={sessions}
          keyExtractor={(item) => `${item.profileId}:${item.id}`}
          ListEmptyComponent={
            <EmptyState
              message={
                selectedProfile
                  ? `No chats for ${selectedProfile.name}.`
                  : "No profiles available."
              }
            />
          }
          renderItem={({ item }) => (
            <ListRow
              onPress={() => router.push(`/chat/${item.profileId}/${item.id}`)}
              subtitle={displaySessionPreview(item.preview)}
              title={displaySessionTitle(item.title)}
            />
          )}
        />
      </Screen>
    </QueryState>
  );
}
