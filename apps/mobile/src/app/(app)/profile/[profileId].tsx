import { Chat01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { SectionHeading } from "@/components/atlas/section-heading";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/features/auth/auth-context";
import { useServer } from "@/features/server/server-context";
import { useAppTheme } from "@/features/theme/theme-provider";
import { useAtlasMutation, useReadyAtlasClient } from "@/hooks/use-atlas-query";
import {
  useMcpQuery,
  useProfileQuery,
  useSkillsQuery,
  useSoulQuery,
  useToolsQuery,
} from "@/hooks/use-workspace";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { isWorkspaceAdmin } from "@/lib/roles";
import { shareBinaryFile } from "@/lib/share-file";
import { NAV_THEME } from "@/lib/theme";

const SOUL_FILES = [
  { key: "soul", label: "Identity" },
  { key: "style", label: "Style" },
  { key: "instructions", label: "Instructions" },
  { key: "memory", label: "Memory" },
] as const;

type SoulKey = (typeof SOUL_FILES)[number]["key"];

export default function ProfileScreen() {
  const router = useRouter();
  const { profileId: rawId } = useLocalSearchParams<{ profileId: string }>();
  const profileId = String(rawId);
  const { activeOrg, user } = useAuth();
  const { activeServer, isCurrentServer } = useServer();
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;
  const client = useReadyAtlasClient();
  const admin = isWorkspaceAdmin({
    activeOrg,
    isPlatformAdmin: user?.isPlatformAdmin,
  });
  const profileQuery = useProfileQuery(profileId);
  const soulQuery = useSoulQuery(profileId);
  const toolsQuery = useToolsQuery();
  const skillsQuery = useSkillsQuery();
  const mcpQuery = useMcpQuery();
  const [name, setName] = useState("");
  const [soulDrafts, setSoulDrafts] = useState<Record<string, string>>({});
  const [openSoul, setOpenSoul] = useState<SoulKey | null>(null);

  useEffect(() => {
    if (profileQuery.data?.name) {
      setName(profileQuery.data.name);
    }
  }, [profileQuery.data?.name]);

  useEffect(() => {
    const files = soulQuery.data?.files;
    if (!files) {
      return;
    }
    setSoulDrafts({
      instructions: files.instructions ?? "",
      memory: files.memory ?? "",
      soul: files.soul ?? "",
      style: files.style ?? "",
    });
  }, [soulQuery.data?.files]);

  const saveProfile = useAtlasMutation((atlas, nextName: string) =>
    atlas.updateProfile(profileId, { name: nextName })
  );
  const saveSoul = useAtlasMutation(
    (atlas, input: { content: string; fileKey: string }) =>
      atlas.writeProfileSoulFile(profileId, input.fileKey, input.content)
  );
  const assignTool = useAtlasMutation((atlas, toolId: string) =>
    atlas.assignTool(profileId, { toolId })
  );
  const unassignTool = useAtlasMutation((atlas, toolId: string) =>
    atlas.unassignTool(profileId, toolId)
  );
  const assignSkill = useAtlasMutation((atlas, skillId: string) =>
    atlas.assignSkill(profileId, { skillId })
  );
  const unassignSkill = useAtlasMutation((atlas, skillId: string) =>
    atlas.unassignSkill(profileId, skillId)
  );
  const assignMcp = useAtlasMutation((atlas, serverId: string) =>
    atlas.assignMcpServer(profileId, { serverId })
  );
  const unassignMcp = useAtlasMutation((atlas, serverId: string) =>
    atlas.unassignMcpServer(profileId, serverId)
  );

  const assignedToolIds = new Set(
    (profileQuery.data?.tools ?? []).map((tool) => tool.id)
  );
  const assignedSkillIds = new Set(
    (profileQuery.data?.skills ?? []).map((skill) => skill.id)
  );
  const assignedMcpIds = new Set(
    (profileQuery.data?.mcpServers ?? []).map((server) => server.id)
  );

  const invalidateProfile = async () => {
    await saveProfile.queryClient.invalidateQueries({
      queryKey: queryKeys.profile(profileId),
    });
    await saveProfile.queryClient.invalidateQueries({
      queryKey: queryKeys.profiles,
    });
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityLabel="New chat"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => router.push(`/chat/${profileId}`)}
              style={{
                alignItems: "center",
                height: 44,
                justifyContent: "center",
                marginRight: 4,
                width: 44,
              }}
            >
              <HugeiconsIcon
                color={colors.primary}
                icon={Chat01Icon}
                size={22}
              />
            </Pressable>
          ),
          headerShown: true,
          title: profileQuery.data?.name ?? "Agent",
        }}
      />
      <RequireWorkspaceAdmin>
        <QueryState
          error={
            profileQuery.error ??
            soulQuery.error ??
            toolsQuery.error ??
            skillsQuery.error ??
            mcpQuery.error
          }
          loading={
            profileQuery.isLoading ||
            soulQuery.isLoading ||
            toolsQuery.isLoading ||
            skillsQuery.isLoading ||
            mcpQuery.isLoading
          }
          onRetry={() => {
            void profileQuery.refetch();
            void soulQuery.refetch();
            void toolsQuery.refetch();
            void skillsQuery.refetch();
            void mcpQuery.refetch();
          }}
        >
          <Screen>
            <ScrollView keyboardShouldPersistTaps="handled">
              {admin ? (
                <View className="flex-row items-center gap-2 border-border border-b px-4 py-3">
                  <Input
                    className="min-w-0 flex-1"
                    onChangeText={setName}
                    value={name}
                  />
                  <Button
                    onPress={() => {
                      void saveProfile
                        .mutateAsync(name.trim())
                        .then(() => invalidateProfile())
                        .catch((error: unknown) => {
                          showMutationError("Could not save agent", error);
                        });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>Save</Text>
                  </Button>
                </View>
              ) : null}

              <SectionHeading title="Soul" />
              {SOUL_FILES.map((file) => (
                <View key={file.key}>
                  <ListRow
                    onPress={() =>
                      setOpenSoul((current) =>
                        current === file.key ? null : file.key
                      )
                    }
                    title={file.label}
                  />
                  {openSoul === file.key ? (
                    <View className="gap-2 border-border border-b px-4 pb-4">
                      <Textarea
                        className="min-h-40"
                        editable={admin}
                        onChangeText={(value) =>
                          setSoulDrafts((current) => ({
                            ...current,
                            [file.key]: value,
                          }))
                        }
                        value={soulDrafts[file.key] ?? ""}
                      />
                      {admin ? (
                        <ActionCluster>
                          <Button
                            onPress={() => {
                              void saveSoul
                                .mutateAsync({
                                  content: soulDrafts[file.key] ?? "",
                                  fileKey: file.key,
                                })
                                .then(() =>
                                  saveSoul.queryClient.invalidateQueries({
                                    queryKey: queryKeys.soul(profileId),
                                  })
                                )
                                .catch((error: unknown) => {
                                  showMutationError(
                                    "Could not save soul",
                                    error
                                  );
                                });
                            }}
                            size="sm"
                            variant="outline"
                          >
                            <Text>Save</Text>
                          </Button>
                        </ActionCluster>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              ))}

              <SectionHeading title="Tools" />
              {(toolsQuery.data ?? []).map((tool) => {
                const assigned = assignedToolIds.has(tool.id);
                return (
                  <ListRow
                    key={tool.id}
                    onPress={
                      admin
                        ? () => {
                            void (
                              assigned
                                ? unassignTool.mutateAsync(tool.id)
                                : assignTool.mutateAsync(tool.id)
                            )
                              .then(() => invalidateProfile())
                              .catch((error: unknown) => {
                                showMutationError(
                                  "Could not update tool",
                                  error
                                );
                              });
                          }
                        : undefined
                    }
                    showChevron={false}
                    title={tool.name}
                    value={assigned ? "On" : "Off"}
                  />
                );
              })}

              <SectionHeading title="Skills" />
              {(skillsQuery.data ?? []).map((skill) => {
                const assigned = assignedSkillIds.has(skill.id);
                return (
                  <ListRow
                    key={skill.id}
                    onPress={
                      admin
                        ? () => {
                            void (
                              assigned
                                ? unassignSkill.mutateAsync(skill.id)
                                : assignSkill.mutateAsync(skill.id)
                            )
                              .then(() => invalidateProfile())
                              .catch((error: unknown) => {
                                showMutationError(
                                  "Could not update skill",
                                  error
                                );
                              });
                          }
                        : undefined
                    }
                    showChevron={false}
                    subtitle={skill.description}
                    title={skill.name}
                    value={assigned ? "On" : "Off"}
                  />
                );
              })}

              <SectionHeading title="MCP" />
              {(mcpQuery.data ?? []).map((server) => {
                const assigned = assignedMcpIds.has(server.id);
                return (
                  <ListRow
                    key={server.id}
                    onPress={
                      admin
                        ? () => {
                            void (
                              assigned
                                ? unassignMcp.mutateAsync(server.id)
                                : assignMcp.mutateAsync(server.id)
                            )
                              .then(() => invalidateProfile())
                              .catch((error: unknown) => {
                                showMutationError(
                                  "Could not update MCP",
                                  error
                                );
                              });
                          }
                        : undefined
                    }
                    showChevron={false}
                    title={server.name}
                    value={assigned ? "On" : server.status}
                  />
                );
              })}

              {admin ? (
                <View className="px-4 py-4">
                  <ActionCluster>
                    <Button
                      onPress={() => {
                        const sourceServerId = activeServer?.id ?? null;
                        if (!(client && isCurrentServer(sourceServerId))) {
                          return;
                        }
                        void client
                          .exportProfilePack(profileId)
                          .then((file) => {
                            if (isCurrentServer(sourceServerId)) {
                              return shareBinaryFile(file.filename, file.data);
                            }
                          })
                          .catch((error: unknown) => {
                            Alert.alert(
                              "Export failed",
                              error instanceof Error ? error.message : ""
                            );
                          });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>Export pack</Text>
                    </Button>
                  </ActionCluster>
                </View>
              ) : null}
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
