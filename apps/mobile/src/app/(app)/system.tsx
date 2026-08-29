import type { DataImportPreviewResponse } from "@atlas/core/contract";
import * as DocumentPicker from "expo-document-picker";
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { InlineForm } from "@/components/atlas/inline-form";
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
import { useAtlasMutation, useReadyAtlasClient } from "@/hooks/use-atlas-query";
import { useProfilesQuery } from "@/hooks/use-profiles";
import {
  useMcpQuery,
  useOrgMemoryQuery,
  useSkillsQuery,
  useSystemStatusQuery,
  useToolsQuery,
} from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import {
  assertDataImportArchiveSize,
  assertPickedDataImportArchiveSize,
} from "@/lib/picked-file-size";
import { queryKeys } from "@/lib/query-keys";
import { shareBinaryFile } from "@/lib/share-file";

type CreateSection = "mcp" | "skill" | "tool" | null;

export default function SystemScreen() {
  const router = useRouter();
  const { activeOrg, user } = useAuth();
  const { activeServer, isCurrentServer } = useServer();
  const client = useReadyAtlasClient();
  const platformAdmin = user?.isPlatformAdmin === true;
  const statusQuery = useSystemStatusQuery();
  const toolsQuery = useToolsQuery();
  const mcpQuery = useMcpQuery();
  const skillsQuery = useSkillsQuery();
  const profilesQuery = useProfilesQuery();
  const memoryQuery = useOrgMemoryQuery(activeOrg?.id);
  const [memory, setMemory] = useState("");
  const [createSection, setCreateSection] = useState<CreateSection>(null);
  const [toolName, setToolName] = useState("");
  const [toolDescription, setToolDescription] = useState("");
  const [modulePath, setModulePath] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [installUrl, setInstallUrl] = useState("");
  const [preview, setPreview] = useState<DataImportPreviewResponse | null>(
    null
  );
  const [importBytes, setImportBytes] = useState<ArrayBuffer | null>(null);
  const [previewServerId, setPreviewServerId] = useState<string | null>(null);

  useEffect(() => {
    if (memoryQuery.data?.content != null) {
      setMemory(memoryQuery.data.content);
    }
  }, [memoryQuery.data?.content]);

  const toggleSection = (section: Exclude<CreateSection, null>) => {
    setCreateSection((current) => (current === section ? null : section));
  };

  const previewImport = async () => {
    const sourceServerId = activeServer?.id ?? null;
    if (!(client && isCurrentServer(sourceServerId))) {
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: "application/zip",
      });
      const asset = result.assets?.[0];
      if (!(asset && isCurrentServer(sourceServerId))) {
        return;
      }
      await assertPickedDataImportArchiveSize(asset);

      const response = await fetch(asset.uri);
      const data = await response.arrayBuffer();
      assertDataImportArchiveSize(data.byteLength);
      if (!isCurrentServer(sourceServerId)) {
        return;
      }

      const nextPreview = await client.previewDataImport(data);
      if (!isCurrentServer(sourceServerId)) {
        return;
      }

      setImportBytes(data);
      setPreview(nextPreview);
      setPreviewServerId(sourceServerId);
    } catch (error) {
      if (!isCurrentServer(sourceServerId)) {
        return;
      }
      setImportBytes(null);
      setPreview(null);
      setPreviewServerId(null);
      Alert.alert(
        "Preview failed",
        error instanceof Error
          ? error.message
          : "Could not preview the archive."
      );
    }
  };

  const saveMemory = useAtlasMutation((atlas, content: string) =>
    atlas.updateOrgMemory(activeOrg?.id ?? "", { content })
  );
  const createTool = useAtlasMutation(
    (atlas, input: { description: string; modulePath: string; name: string }) =>
      atlas.createTool({
        description: input.description,
        handlerConfig: { modulePath: input.modulePath },
        handlerType: "javascript",
        name: input.name,
      })
  );
  const createMcp = useAtlasMutation(
    (atlas, input: { name: string; url: string }) =>
      atlas.createMcpServer({
        config: { url: input.url },
        connect: true,
        name: input.name,
        transport: "http",
      })
  );
  const createSkill = useAtlasMutation(
    (atlas, input: { body: string; description: string; name: string }) =>
      atlas.createSkill({
        body: input.body,
        description: input.description,
        name: input.name,
      })
  );
  const installSkill = useAtlasMutation(
    (atlas, input: { profileId: string; url: string }) =>
      atlas.installSkill(input)
  );
  const syncSkills = useAtlasMutation((atlas) => atlas.syncSkills());

  const defaultProfile =
    profilesQuery.data?.find((profile) => profile.isDefault) ??
    profilesQuery.data?.[0];
  const status = statusQuery.data;
  const toolNameTrimmed = toolName.trim();
  const toolDescriptionTrimmed = toolDescription.trim();
  const modulePathTrimmed = modulePath.trim();
  const mcpNameTrimmed = mcpName.trim();
  const mcpUrlTrimmed = mcpUrl.trim();
  const skillNameTrimmed = skillName.trim();
  const skillDescriptionTrimmed = skillDescription.trim();
  const skillBodyTrimmed = skillBody.trim();
  const installUrlTrimmed = installUrl.trim();
  const memoryTrimmed = memory.trim();
  const canCreateTool =
    toolNameTrimmed.length > 0 &&
    toolDescriptionTrimmed.length > 0 &&
    modulePathTrimmed.length > 0;
  const canCreateMcp = mcpNameTrimmed.length > 0 && mcpUrlTrimmed.length > 0;
  const canCreateSkill =
    skillNameTrimmed.length > 0 &&
    skillDescriptionTrimmed.length > 0 &&
    skillBodyTrimmed.length > 0;
  const canInstallSkill = installUrlTrimmed.length > 0;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "System" }} />
      <RequireWorkspaceAdmin>
        <QueryState
          error={
            statusQuery.error ??
            toolsQuery.error ??
            mcpQuery.error ??
            skillsQuery.error ??
            profilesQuery.error ??
            memoryQuery.error
          }
          loading={
            statusQuery.isLoading ||
            toolsQuery.isLoading ||
            mcpQuery.isLoading ||
            skillsQuery.isLoading ||
            profilesQuery.isLoading ||
            memoryQuery.isLoading
          }
          onRetry={() => {
            void statusQuery.refetch();
            void toolsQuery.refetch();
            void mcpQuery.refetch();
            void skillsQuery.refetch();
            void profilesQuery.refetch();
            void memoryQuery.refetch();
          }}
        >
          <Screen className="px-0">
            <ScrollView keyboardShouldPersistTaps="handled">
              <SectionHeading title="Workers" />
              <ListRow
                title="Telegram"
                value={status?.telegramWorker.running ? "Running" : "Stopped"}
              />
              <ListRow
                title="WhatsApp"
                value={status?.whatsappWorker.running ? "Running" : "Stopped"}
              />
              <ListRow
                title="Discord"
                value={status?.discordWorker.running ? "Running" : "Stopped"}
              />
              <ListRow
                title="Automation"
                value={status?.automationWorker.running ? "Running" : "Stopped"}
              />

              <SectionHeading
                onAdd={() => toggleSection("tool")}
                title="Tools"
              />
              {(toolsQuery.data ?? []).map((tool) => (
                <ListRow
                  key={tool.id}
                  onPress={() => router.push(`/tool/${tool.id}`)}
                  subtitle={tool.description}
                  title={tool.name}
                />
              ))}
              {createSection === "tool" ? (
                <InlineForm>
                  <Input
                    onChangeText={setToolName}
                    placeholder="Name"
                    value={toolName}
                  />
                  <Input
                    onChangeText={setToolDescription}
                    placeholder="Description"
                    value={toolDescription}
                  />
                  <Input
                    autoCapitalize="none"
                    onChangeText={setModulePath}
                    placeholder="echo.js"
                    value={modulePath}
                  />
                  <Button
                    disabled={createTool.isPending || !canCreateTool}
                    onPress={() => {
                      void createTool
                        .mutateAsync({
                          description: toolDescriptionTrimmed,
                          modulePath: modulePathTrimmed,
                          name: toolNameTrimmed,
                        })
                        .then(async () => {
                          setToolName("");
                          setToolDescription("");
                          setModulePath("");
                          setCreateSection(null);
                          await createTool.queryClient.invalidateQueries({
                            queryKey: queryKeys.tools,
                          });
                        })
                        .catch((error: unknown) => {
                          Alert.alert(
                            "Could not create tool",
                            error instanceof Error ? error.message : ""
                          );
                        });
                    }}
                  >
                    <Text>
                      {createTool.isPending
                        ? "Registering tool…"
                        : "Register tool"}
                    </Text>
                  </Button>
                </InlineForm>
              ) : null}

              <SectionHeading onAdd={() => toggleSection("mcp")} title="MCP" />
              {(mcpQuery.data ?? []).map((server) => (
                <ListRow
                  key={server.id}
                  onPress={() => router.push(`/mcp/${server.id}`)}
                  subtitle={`${server.transport} · ${server.status}`}
                  title={server.name}
                />
              ))}
              {createSection === "mcp" ? (
                <InlineForm>
                  <Input
                    onChangeText={setMcpName}
                    placeholder="Name"
                    value={mcpName}
                  />
                  <Input
                    autoCapitalize="none"
                    onChangeText={setMcpUrl}
                    placeholder="https://mcp.example.com"
                    value={mcpUrl}
                  />
                  <Button
                    disabled={createMcp.isPending || !canCreateMcp}
                    onPress={() => {
                      void createMcp
                        .mutateAsync({
                          name: mcpNameTrimmed,
                          url: mcpUrlTrimmed,
                        })
                        .then(async (response) => {
                          setMcpName("");
                          setMcpUrl("");
                          setCreateSection(null);
                          await createMcp.queryClient.invalidateQueries({
                            queryKey: queryKeys.mcp,
                          });
                          router.push(`/mcp/${response.server.id}`);
                        })
                        .catch((error: unknown) => {
                          Alert.alert(
                            "Could not add MCP",
                            error instanceof Error ? error.message : ""
                          );
                        });
                    }}
                  >
                    <Text>
                      {createMcp.isPending ? "Adding MCP…" : "Add MCP"}
                    </Text>
                  </Button>
                </InlineForm>
              ) : null}

              <SectionHeading
                onAdd={() => toggleSection("skill")}
                title="Skills"
              />
              {(skillsQuery.data ?? []).map((skill) => (
                <ListRow
                  key={skill.id}
                  onPress={() => router.push(`/skill/${skill.id}`)}
                  subtitle={skill.description}
                  title={skill.name}
                />
              ))}
              {createSection === "skill" ? (
                <InlineForm>
                  <Input
                    onChangeText={setSkillName}
                    placeholder="Name"
                    value={skillName}
                  />
                  <Input
                    onChangeText={setSkillDescription}
                    placeholder="Description"
                    value={skillDescription}
                  />
                  <Textarea
                    className="min-h-28"
                    onChangeText={setSkillBody}
                    placeholder="Skill body"
                    value={skillBody}
                  />
                  <Button
                    disabled={createSkill.isPending || !canCreateSkill}
                    onPress={() => {
                      void createSkill
                        .mutateAsync({
                          body: skillBodyTrimmed,
                          description: skillDescriptionTrimmed,
                          name: skillNameTrimmed,
                        })
                        .then(async (response) => {
                          setSkillName("");
                          setSkillDescription("");
                          setSkillBody("");
                          setCreateSection(null);
                          await createSkill.queryClient.invalidateQueries({
                            queryKey: queryKeys.skills,
                          });
                          router.push(`/skill/${response.skill.id}`);
                        })
                        .catch((error: unknown) => {
                          Alert.alert(
                            "Could not create skill",
                            error instanceof Error ? error.message : ""
                          );
                        });
                    }}
                  >
                    <Text>
                      {createSkill.isPending
                        ? "Creating skill…"
                        : "Create skill"}
                    </Text>
                  </Button>
                  <Input
                    autoCapitalize="none"
                    onChangeText={setInstallUrl}
                    placeholder="https://.../SKILL.md"
                    value={installUrl}
                  />
                  <ActionCluster>
                    <Button
                      disabled={installSkill.isPending || !canInstallSkill}
                      onPress={() => {
                        if (!defaultProfile) {
                          Alert.alert("No profile to install into.");
                          return;
                        }
                        void installSkill
                          .mutateAsync({
                            profileId: defaultProfile.id,
                            url: installUrlTrimmed,
                          })
                          .then(async (response) => {
                            setInstallUrl("");
                            setCreateSection(null);
                            await installSkill.queryClient.invalidateQueries({
                              queryKey: queryKeys.skills,
                            });
                            router.push(`/skill/${response.skill.id}`);
                          })
                          .catch((error: unknown) => {
                            Alert.alert(
                              "Could not install skill",
                              error instanceof Error ? error.message : ""
                            );
                          });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>
                        {installSkill.isPending ? "Installing…" : "Install URL"}
                      </Text>
                    </Button>
                    <Button
                      disabled={syncSkills.isPending}
                      onPress={() => {
                        void syncSkills
                          .mutateAsync(undefined)
                          .then(() =>
                            syncSkills.queryClient.invalidateQueries({
                              queryKey: queryKeys.skills,
                            })
                          )
                          .catch((error: unknown) => {
                            showMutationError("Could not sync skills", error);
                          });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>{syncSkills.isPending ? "Syncing…" : "Sync"}</Text>
                    </Button>
                  </ActionCluster>
                </InlineForm>
              ) : null}

              {activeOrg ? (
                <>
                  <SectionHeading title="Org memory" />
                  <View className="gap-2 px-4 py-3">
                    <Textarea
                      className="min-h-28"
                      onChangeText={setMemory}
                      value={memory}
                    />
                    <ActionCluster>
                      <Button
                        disabled={saveMemory.isPending}
                        onPress={() => {
                          void saveMemory
                            .mutateAsync(memoryTrimmed)
                            .then(() =>
                              saveMemory.queryClient.invalidateQueries({
                                queryKey: queryKeys.orgMemory(activeOrg.id),
                              })
                            )
                            .catch((error: unknown) => {
                              showMutationError("Could not save memory", error);
                            });
                        }}
                        size="sm"
                        variant="outline"
                      >
                        <Text>
                          {saveMemory.isPending ? "Saving…" : "Save memory"}
                        </Text>
                      </Button>
                    </ActionCluster>
                  </View>
                </>
              ) : null}

              {platformAdmin ? (
                <View className="gap-2 px-4 pt-4 pb-8">
                  <Text className="font-heading">Data</Text>
                  <ActionCluster>
                    <Button
                      onPress={() => {
                        const sourceServerId = activeServer?.id ?? null;
                        if (!(client && isCurrentServer(sourceServerId))) {
                          return;
                        }
                        void client
                          .exportData()
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
                      <Text>Export</Text>
                    </Button>
                    <Button
                      onPress={() => {
                        void previewImport();
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>Preview import</Text>
                    </Button>
                    {preview ? (
                      <Button
                        onPress={() => {
                          const sourceServerId = previewServerId;
                          if (
                            !(
                              client &&
                              importBytes &&
                              sourceServerId &&
                              isCurrentServer(sourceServerId)
                            )
                          ) {
                            return;
                          }
                          confirmDestructive({
                            confirmLabel: "Restore",
                            message: "This replaces server data.",
                            onConfirm: () => {
                              if (!isCurrentServer(sourceServerId)) {
                                return;
                              }
                              void client
                                .restoreDataImport(importBytes, {
                                  confirm: true,
                                })
                                .then(() => {
                                  if (!isCurrentServer(sourceServerId)) {
                                    return;
                                  }
                                  setPreview(null);
                                  setImportBytes(null);
                                  setPreviewServerId(null);
                                  Alert.alert("Restore complete");
                                })
                                .catch((error: unknown) => {
                                  if (!isCurrentServer(sourceServerId)) {
                                    return;
                                  }
                                  Alert.alert(
                                    "Restore failed",
                                    error instanceof Error ? error.message : ""
                                  );
                                });
                            },
                            title: "Restore archive",
                          });
                        }}
                        size="sm"
                        variant="destructive"
                      >
                        <Text>Restore</Text>
                      </Button>
                    ) : null}
                  </ActionCluster>
                  {preview ? (
                    <Text className="text-muted-foreground text-sm">
                      {preview.archiveFileCount} files ·{" "}
                      {preview.willReplaceRoot ? "replaces root" : "keeps root"}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
