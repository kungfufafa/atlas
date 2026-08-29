import { useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Alert, ScrollView } from "react-native";
import { EmptyState } from "@/components/atlas/empty-state";
import { HeaderAddButton } from "@/components/atlas/header-add-button";
import { InlineForm } from "@/components/atlas/inline-form";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/features/auth/auth-context";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useProfilesQuery } from "@/hooks/use-profiles";
import { queryKeys } from "@/lib/query-keys";
import { isWorkspaceAdmin } from "@/lib/roles";

function displayProfileModel(model: string | null | undefined): string {
  if (!model) {
    return "Default model";
  }
  const separator = model.lastIndexOf("::");
  if (separator >= 0) {
    const slug = model.slice(separator + 2).trim();
    return slug || "Default model";
  }
  return model;
}

export default function AgentsScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { activeOrg, user } = useAuth();
  const admin = isWorkspaceAdmin({
    activeOrg,
    isPlatformAdmin: user?.isPlatformAdmin,
  });
  const profilesQuery = useProfilesQuery();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const createProfile = useAtlasMutation((client, profileName: string) =>
    client.createProfile({ name: profileName })
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: admin
        ? () => (
            <HeaderAddButton
              accessibilityLabel="New agent"
              disabled={createProfile.isPending}
              onPress={() => setCreating((current) => !current)}
            />
          )
        : undefined,
    });
  }, [admin, createProfile.isPending, navigation]);

  return (
    <RequireWorkspaceAdmin>
      <QueryState
        error={profilesQuery.error}
        loading={profilesQuery.isLoading}
        onRetry={() => {
          void profilesQuery.refetch();
        }}
      >
        <Screen>
          <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
            {admin && creating ? (
              <InlineForm>
                <Input
                  onChangeText={setName}
                  placeholder="New agent name"
                  value={name}
                />
                <Button
                  disabled={createProfile.isPending || name.trim().length === 0}
                  onPress={() => {
                    void createProfile
                      .mutateAsync(name.trim())
                      .then(async (response) => {
                        setName("");
                        setCreating(false);
                        await createProfile.queryClient.invalidateQueries({
                          queryKey: queryKeys.profiles,
                        });
                        router.push(`/profile/${response.profile.id}`);
                      })
                      .catch((error: unknown) => {
                        Alert.alert(
                          "Could not create agent",
                          error instanceof Error ? error.message : ""
                        );
                      });
                  }}
                >
                  <Text>
                    {createProfile.isPending ? "Creating…" : "Create agent"}
                  </Text>
                </Button>
              </InlineForm>
            ) : null}
            {(profilesQuery.data ?? []).length === 0 ? (
              <EmptyState message="No agents in this workspace." />
            ) : (
              (profilesQuery.data ?? []).map((profile) => (
                <ListRow
                  key={profile.id}
                  onPress={() => router.push(`/profile/${profile.id}`)}
                  subtitle={displayProfileModel(profile.model)}
                  title={profile.name}
                />
              ))
            )}
          </ScrollView>
        </Screen>
      </QueryState>
    </RequireWorkspaceAdmin>
  );
}
