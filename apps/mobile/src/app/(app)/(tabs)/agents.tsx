import type { ProfileSummary } from "@atlas/core/contract";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Alert, FlatList, Pressable, View } from "react-native";
import { EmptyState } from "@/components/atlas/empty-state";
import { HeaderAddButton } from "@/components/atlas/header-add-button";
import { InlineForm } from "@/components/atlas/inline-form";
import { ProfileAvatar } from "@/components/atlas/profile-avatar";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/features/auth/auth-context";
import { useAppTheme } from "@/features/theme/theme-provider";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useProfilesQuery } from "@/hooks/use-profiles";
import { queryKeys } from "@/lib/query-keys";
import { isWorkspaceAdmin } from "@/lib/roles";
import { NAV_THEME } from "@/lib/theme";

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

function profileRole(profile: ProfileSummary): string | null {
  if (profile.isSuper) {
    return "Super";
  }
  if (profile.isDefault) {
    return "Default";
  }
  return null;
}

function formatToolCount(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

function AgentProfileCard({
  onPress,
  profile,
}: {
  onPress: () => void;
  profile: ProfileSummary;
}) {
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;
  const role = profileRole(profile);
  const model = displayProfileModel(profile.model);
  const roleLabel = role ? `${role} agent` : "Agent";
  const toolCount = formatToolCount(profile.toolCount);

  return (
    <Pressable
      accessibilityLabel={`${profile.name}, ${roleLabel}, ${model}, ${toolCount}`}
      accessibilityRole="button"
      className="flex-row items-center gap-3.5 rounded-2xl border border-border bg-card p-3.5 shadow-sm active:bg-secondary/40"
      onPress={onPress}
    >
      <ProfileAvatar profile={profile} size="lg" />
      <View className="min-w-0 flex-1 gap-1.5">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 flex-shrink font-heading text-lg"
            numberOfLines={1}
          >
            {profile.name}
          </Text>
          {role ? (
            <View className="rounded-full bg-primary/10 px-2 py-0.5">
              <Text className="font-medium text-primary text-xs">{role}</Text>
            </View>
          ) : null}
        </View>
        <View className="flex-row items-center gap-1.5">
          <Text
            className="min-w-0 flex-shrink text-muted-foreground text-sm"
            numberOfLines={1}
          >
            {model}
          </Text>
          <Text className="text-muted-foreground text-sm">·</Text>
          <Text className="text-muted-foreground text-sm">{toolCount}</Text>
        </View>
      </View>
      <HugeiconsIcon color={colors.text} icon={ArrowRight01Icon} size={18} />
    </Pressable>
  );
}

function AgentProfileSeparator() {
  return <View className="h-3" />;
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
  const profiles = profilesQuery.data ?? [];

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
          <FlatList
            className="flex-1"
            contentContainerClassName="py-3"
            data={profiles}
            ItemSeparatorComponent={AgentProfileSeparator}
            initialNumToRender={6}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(profile) => profile.id}
            ListEmptyComponent={
              <EmptyState message="No agents in this workspace." />
            }
            ListHeaderComponent={
              admin && creating ? (
                <View className="mb-3">
                  <InlineForm>
                    <Input
                      onChangeText={setName}
                      placeholder="New agent name"
                      value={name}
                    />
                    <Button
                      disabled={
                        createProfile.isPending || name.trim().length === 0
                      }
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
                </View>
              ) : null
            }
            maxToRenderPerBatch={6}
            renderItem={({ item: profile }) => (
              <View className="px-4">
                <AgentProfileCard
                  onPress={() => router.push(`/profile/${profile.id}`)}
                  profile={profile}
                />
              </View>
            )}
            windowSize={5}
          />
        </Screen>
      </QueryState>
    </RequireWorkspaceAdmin>
  );
}
