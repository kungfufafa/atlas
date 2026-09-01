import type { ImageAttachment, ProfileChangeEvent } from "@atlas/core/contract";
import { Camera01Icon, Chat01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { ListRow } from "@/components/atlas/list-row";
import { ProfileAvatar } from "@/components/atlas/profile-avatar";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { SectionHeading } from "@/components/atlas/section-heading";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/features/auth/auth-context";
import {
  formatProfileChangeField,
  formatProfileChangeMetadata,
  formatProfileChangeValue,
} from "@/features/profiles/profile-history";
import { useServer } from "@/features/server/server-context";
import { useAppTheme } from "@/features/theme/theme-provider";
import { useAtlasMutation, useReadyAtlasClient } from "@/hooks/use-atlas-query";
import {
  useMcpQuery,
  useProfileHistoryQuery,
  useProfileQuery,
  useSkillsQuery,
  useSoulQuery,
  useToolsQuery,
} from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import {
  profileAvatarResizeActions,
  shouldPreserveAvatarTransparency,
} from "@/lib/profile-avatar";
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

const PROFILE_AVATAR_JPEG_QUALITY = 0.82;
const PROFILE_AVATAR_PNG_QUALITY = 1;

type SoulKey = (typeof SOUL_FILES)[number]["key"];
type IdentityOperation = "avatar" | "name";

function HistoryValue({
  event,
  label,
  value,
}: {
  event: ProfileChangeEvent;
  label: "After" | "Before";
  value: string | null;
}) {
  return (
    <View className="gap-1.5">
      <Text className="font-medium text-muted-foreground text-xs uppercase">
        {label}
      </Text>
      <View className="rounded-lg border border-border bg-muted/35 p-3">
        <Text className="font-mono text-xs" selectable>
          {formatProfileChangeValue(value, event.field)}
        </Text>
      </View>
    </View>
  );
}

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [openHistoryEventId, setOpenHistoryEventId] = useState<string | null>(
    null
  );
  const identityOperationRef = useRef<IdentityOperation | null>(null);
  const [identityOperation, setIdentityOperation] =
    useState<IdentityOperation | null>(null);
  const historyQuery = useProfileHistoryQuery(profileId, admin && historyOpen);

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
  const uploadAvatar = useAtlasMutation((atlas, attachment: ImageAttachment) =>
    atlas.uploadProfileAvatar(profileId, attachment)
  );
  const removeAvatar = useAtlasMutation((atlas) =>
    atlas.deleteProfileAvatar(profileId)
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
  const cloneProfile = useAtlasMutation((atlas) =>
    atlas.cloneProfile(profileId)
  );
  const deleteProfile = useAtlasMutation((atlas) =>
    atlas.deleteProfile(profileId)
  );

  const assignedToolIds = new Set(
    (profileQuery.data?.tools ?? []).map((tool) => tool.id)
  );
  const assignedSkillIds = new Set(
    (profileQuery.data?.skills ?? []).map((skill) => skill.id)
  );
  const nameTrimmed = name.trim();
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
    await saveProfile.queryClient.invalidateQueries({
      queryKey: queryKeys.profileHistory(profileId),
    });
  };
  const invalidateAvatarMetadata = async () => {
    await Promise.all([
      uploadAvatar.queryClient.invalidateQueries({
        queryKey: queryKeys.profile(profileId),
      }),
      uploadAvatar.queryClient.invalidateQueries({
        queryKey: queryKeys.profiles,
      }),
      uploadAvatar.queryClient.invalidateQueries({
        queryKey: queryKeys.profileHistory(profileId),
      }),
    ]);
  };
  const beginIdentityOperation = (operation: IdentityOperation): boolean => {
    if (identityOperationRef.current) {
      return false;
    }
    identityOperationRef.current = operation;
    setIdentityOperation(operation);
    return true;
  };
  const finishIdentityOperation = () => {
    identityOperationRef.current = null;
    setIdentityOperation(null);
  };
  const pickAvatar = async () => {
    if (!beginIdentityOperation("avatar")) {
      return;
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        base64: false,
        mediaTypes: ["images"],
      });
      const asset = result.assets?.[0];
      if (!asset) {
        return;
      }

      const preserveTransparency = shouldPreserveAvatarTransparency(
        asset.mimeType
      );
      const outputFormat = preserveTransparency
        ? SaveFormat.PNG
        : SaveFormat.JPEG;
      const outputMediaType = preserveTransparency ? "image/png" : "image/jpeg";
      const normalizedAvatar = await manipulateAsync(
        asset.uri,
        profileAvatarResizeActions(asset.width, asset.height),
        {
          base64: true,
          compress: preserveTransparency
            ? PROFILE_AVATAR_PNG_QUALITY
            : PROFILE_AVATAR_JPEG_QUALITY,
          format: outputFormat,
        }
      );
      if (!normalizedAvatar.base64) {
        throw new Error("Could not process the selected profile photo.");
      }

      await uploadAvatar.mutateAsync({
        data: normalizedAvatar.base64,
        mediaType: outputMediaType,
      });
      await invalidateAvatarMetadata();
      await uploadAvatar.queryClient.invalidateQueries({
        queryKey: queryKeys.profileAvatar(profileId),
      });
    } catch (error) {
      showMutationError("Could not update profile photo", error);
    } finally {
      finishIdentityOperation();
    }
  };
  const avatarBusy =
    identityOperation === "avatar" ||
    uploadAvatar.isPending ||
    removeAvatar.isPending;
  const identityBusy =
    identityOperation !== null ||
    saveProfile.isPending ||
    uploadAvatar.isPending ||
    removeAvatar.isPending;
  const profileActionBusy =
    identityBusy ||
    cloneProfile.isPending ||
    deleteProfile.isPending ||
    exporting;
  const isToolBusy = assignTool.isPending || unassignTool.isPending;
  const isSkillBusy = assignSkill.isPending || unassignSkill.isPending;
  const isMcpBusy = assignMcp.isPending || unassignMcp.isPending;

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
              {profileQuery.data ? (
                <View className="flex-row items-center gap-4 border-border border-b bg-card px-4 py-5">
                  <Pressable
                    accessibilityLabel={
                      avatarBusy
                        ? "Updating profile photo"
                        : "Change profile photo"
                    }
                    accessibilityRole="button"
                    accessibilityState={{
                      busy: avatarBusy,
                      disabled: !admin || profileActionBusy,
                    }}
                    disabled={!admin || profileActionBusy}
                    onPress={() => {
                      void pickAvatar();
                    }}
                  >
                    <ProfileAvatar profile={profileQuery.data} size="xl" />
                    {admin ? (
                      <View className="absolute right-0 bottom-0 h-8 w-8 items-center justify-center rounded-full border-2 border-card bg-primary">
                        {avatarBusy ? (
                          <ActivityIndicator color="#fff" size="small" />
                        ) : (
                          <HugeiconsIcon
                            color="#fff"
                            icon={Camera01Icon}
                            size={16}
                          />
                        )}
                      </View>
                    ) : null}
                  </Pressable>
                  <View className="min-w-0 flex-1 gap-2">
                    {admin ? (
                      <>
                        <Input onChangeText={setName} value={name} />
                        <View className="flex-row flex-wrap gap-2">
                          <Button
                            disabled={
                              saveProfile.isPending ||
                              profileActionBusy ||
                              !nameTrimmed ||
                              nameTrimmed === profileQuery.data.name
                            }
                            onPress={() => {
                              if (!beginIdentityOperation("name")) {
                                return;
                              }
                              void (async () => {
                                try {
                                  await saveProfile.mutateAsync(nameTrimmed);
                                  await invalidateProfile();
                                } catch (error) {
                                  showMutationError(
                                    "Could not save agent",
                                    error
                                  );
                                } finally {
                                  finishIdentityOperation();
                                }
                              })();
                            }}
                            size="sm"
                            variant="outline"
                          >
                            <Text>
                              {saveProfile.isPending ? "Saving…" : "Save"}
                            </Text>
                          </Button>
                          {profileQuery.data.hasAvatar ? (
                            <Button
                              disabled={profileActionBusy}
                              onPress={() => {
                                confirmDestructive({
                                  confirmLabel: "Remove",
                                  onConfirm: () => {
                                    if (!beginIdentityOperation("avatar")) {
                                      return;
                                    }
                                    void (async () => {
                                      try {
                                        await removeAvatar.mutateAsync(
                                          undefined
                                        );
                                        await invalidateAvatarMetadata();
                                      } catch (error) {
                                        showMutationError(
                                          "Could not remove profile photo",
                                          error
                                        );
                                      } finally {
                                        finishIdentityOperation();
                                      }
                                    })();
                                  },
                                  title: "Remove profile photo",
                                });
                              }}
                              size="sm"
                              variant="ghost"
                            >
                              <Text className="text-destructive">
                                Remove photo
                              </Text>
                            </Button>
                          ) : null}
                        </View>
                      </>
                    ) : (
                      <Text className="font-heading text-xl">
                        {profileQuery.data.name}
                      </Text>
                    )}
                  </View>
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
                            disabled={
                              saveSoul.isPending ||
                              soulDrafts[file.key] === undefined
                            }
                            onPress={() => {
                              void saveSoul
                                .mutateAsync({
                                  content: soulDrafts[file.key] ?? "",
                                  fileKey: file.key,
                                })
                                .then(() =>
                                  Promise.all([
                                    saveSoul.queryClient.invalidateQueries({
                                      queryKey: queryKeys.soul(profileId),
                                    }),
                                    saveSoul.queryClient.invalidateQueries({
                                      queryKey:
                                        queryKeys.profileHistory(profileId),
                                    }),
                                  ])
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
                            <Text>
                              {saveSoul.isPending ? "Saving…" : "Save"}
                            </Text>
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
                      admin && !isToolBusy
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
                      admin && !isSkillBusy
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
                      admin && !isMcpBusy
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
                <>
                  <SectionHeading title="History" />
                  <ListRow
                    onPress={() => {
                      setHistoryOpen((current) => !current);
                      setOpenHistoryEventId(null);
                    }}
                    showChevron={false}
                    title="Change history"
                    value={historyOpen ? "Hide" : "View"}
                  />
                  {historyOpen ? (
                    historyQuery.isLoading ? (
                      <View className="border-border border-b px-4 py-3">
                        <Text className="text-muted-foreground text-sm">
                          Loading history…
                        </Text>
                      </View>
                    ) : historyQuery.isError && !historyQuery.data ? (
                      <View className="gap-2 border-border border-b px-4 py-3">
                        <Text className="text-destructive text-sm">
                          Could not load history.
                        </Text>
                        <Button
                          className="self-start"
                          onPress={() => void historyQuery.refetch()}
                          size="sm"
                          variant="outline"
                        >
                          <Text>Retry</Text>
                        </Button>
                      </View>
                    ) : historyQuery.data?.length ? (
                      <>
                        {historyQuery.data.map((event) => {
                          const eventOpen = openHistoryEventId === event.id;
                          return (
                            <View key={event.id}>
                              <ListRow
                                onPress={() =>
                                  setOpenHistoryEventId((current) =>
                                    current === event.id ? null : event.id
                                  )
                                }
                                showChevron={false}
                                subtitle={formatProfileChangeMetadata(event)}
                                title={formatProfileChangeField(event.field)}
                                value={eventOpen ? "Hide" : "View"}
                              />
                              {eventOpen ? (
                                <View className="gap-3 border-border border-b px-4 py-4">
                                  <HistoryValue
                                    event={event}
                                    label="Before"
                                    value={event.beforeValue}
                                  />
                                  <HistoryValue
                                    event={event}
                                    label="After"
                                    value={event.afterValue}
                                  />
                                </View>
                              ) : null}
                            </View>
                          );
                        })}
                        {historyQuery.hasNextPage ? (
                          <View className="border-border border-b px-4 py-3">
                            <Button
                              disabled={historyQuery.isFetchingNextPage}
                              onPress={() => void historyQuery.fetchNextPage()}
                              size="sm"
                              variant="outline"
                            >
                              <Text>
                                {historyQuery.isFetchingNextPage
                                  ? "Loading…"
                                  : historyQuery.isFetchNextPageError
                                    ? "Retry loading more"
                                    : "Load more"}
                              </Text>
                            </Button>
                          </View>
                        ) : null}
                      </>
                    ) : (
                      <View className="border-border border-b px-4 py-3">
                        <Text className="text-muted-foreground text-sm">
                          No changes yet.
                        </Text>
                      </View>
                    )
                  ) : null}
                </>
              ) : null}

              {admin ? (
                <View className="gap-3 px-4 py-4">
                  <ActionCluster>
                    <Button
                      disabled={profileActionBusy}
                      onPress={() => {
                        const sourceServerId = activeServer?.id ?? null;
                        if (!(client && isCurrentServer(sourceServerId))) {
                          return;
                        }

                        setExporting(true);
                        void (async () => {
                          try {
                            const file =
                              await client.exportProfilePack(profileId);
                            if (isCurrentServer(sourceServerId)) {
                              await shareBinaryFile(file.filename, file.data);
                            }
                          } catch (error) {
                            showMutationError("Export failed", error);
                          } finally {
                            setExporting(false);
                          }
                        })();
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>{exporting ? "Exporting…" : "Export pack"}</Text>
                    </Button>
                    {profileQuery.data?.isSuper ? null : (
                      <Button
                        disabled={profileActionBusy}
                        onPress={() => {
                          void cloneProfile
                            .mutateAsync(undefined)
                            .then(async (response) => {
                              await cloneProfile.queryClient.invalidateQueries({
                                queryKey: queryKeys.profiles,
                              });
                              router.replace(`/profile/${response.profile.id}`);
                            })
                            .catch((error: unknown) => {
                              showMutationError("Could not clone agent", error);
                            });
                        }}
                        size="sm"
                        variant="outline"
                      >
                        <Text>
                          {cloneProfile.isPending ? "Cloning…" : "Clone"}
                        </Text>
                      </Button>
                    )}
                  </ActionCluster>
                  {profileQuery.data?.isSuper ||
                  profileQuery.data?.isDefault ? null : (
                    <Button
                      disabled={profileActionBusy}
                      onPress={() => {
                        confirmDestructive({
                          message: profileQuery.data?.name,
                          onConfirm: () => {
                            void deleteProfile
                              .mutateAsync(undefined)
                              .then(async () => {
                                await deleteProfile.queryClient.invalidateQueries(
                                  { queryKey: queryKeys.profiles }
                                );
                                router.replace("/(app)/(tabs)/agents");
                              })
                              .catch((error: unknown) => {
                                showMutationError(
                                  "Could not delete agent",
                                  error
                                );
                              });
                          },
                          title: "Delete agent",
                        });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>
                        {deleteProfile.isPending ? "Deleting…" : "Delete agent"}
                      </Text>
                    </Button>
                  )}
                </View>
              ) : null}
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
