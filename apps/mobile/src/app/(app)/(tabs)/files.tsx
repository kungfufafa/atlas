import type { KnowledgeBaseDuplicateAction } from "@atlas/core/contract";
import * as DocumentPicker from "expo-document-picker";
import { useNavigation, useRouter } from "expo-router";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { Alert, Platform, ScrollView } from "react-native";
import { EmptyState } from "@/components/atlas/empty-state";
import { HeaderAddButton } from "@/components/atlas/header-add-button";
import { ListRow } from "@/components/atlas/list-row";
import { ProfileSelector } from "@/components/atlas/profile-selector";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { Segmented } from "@/components/atlas/segmented";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { formatBytes } from "@/features/chat/chat-items";
import { useActiveProfileSelection } from "@/hooks/use-active-profile-selection";
import { useAtlasMutation, useReadyAtlasClient } from "@/hooks/use-atlas-query";
import { useProfilesQuery } from "@/hooks/use-profiles";
import {
  useAllArtifactsQuery,
  useAllKnowledgeQuery,
} from "@/hooks/use-workspace";
import { assertDocumentSize } from "@/lib/compress-image";
import { displayFileKind, fileBasename, fileFolder } from "@/lib/file-display";
import {
  isKnowledgeBaseFilename,
  KNOWLEDGE_BASE_SUPPORTED_TYPE_LABEL,
} from "@/lib/kb-files";
import {
  formatKnowledgeBaseDuplicatePrompt,
  type KnowledgeBaseDuplicateContext,
  type KnowledgeBaseDuplicateDecision,
  uploadKnowledgeBaseDocumentWithDuplicateResolution,
} from "@/lib/knowledge-upload";
import { assertPickedDocumentSize } from "@/lib/picked-file-size";
import { filterProfileScopedItems } from "@/lib/profile-selection";
import { queryKeys } from "@/lib/query-keys";

type FilesTab = "artifacts" | "knowledge";

async function fileToBase64(uri: string): Promise<string> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fileSubtitle(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function decideKnowledgeBaseDuplicate(
  context: KnowledgeBaseDuplicateContext
): Promise<KnowledgeBaseDuplicateDecision> {
  const message = formatKnowledgeBaseDuplicatePrompt(context);
  if (Platform.OS === "web") {
    return Promise.resolve(globalThis.confirm(message) ? "replace" : "skip");
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (decision: KnowledgeBaseDuplicateDecision) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(decision);
    };

    Alert.alert(
      "Document already exists",
      message,
      [
        {
          onPress: () => settle("cancel"),
          style: "cancel",
          text: "Cancel",
        },
        { onPress: () => settle("skip"), text: "Skip" },
        {
          onPress: () => settle("replace"),
          style: "destructive",
          text: "Replace",
        },
      ],
      {
        cancelable: true,
        onDismiss: () => settle("cancel"),
      }
    );
  });
}

export default function FilesScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const client = useReadyAtlasClient();
  const [tab, setTab] = useState<FilesTab>("artifacts");
  const artifactsQuery = useAllArtifactsQuery();
  const knowledgeQuery = useAllKnowledgeQuery();
  const profilesQuery = useProfilesQuery();
  const profiles = profilesQuery.data ?? [];
  const { isLoading, selectProfile, selectedProfileId } =
    useActiveProfileSelection(profilesQuery.data);
  const selectedProfile = profiles.find(
    (profile) => profile.id === selectedProfileId
  );
  const artifacts = useMemo(
    () =>
      filterProfileScopedItems(artifactsQuery.data ?? [], selectedProfileId),
    [artifactsQuery.data, selectedProfileId]
  );
  const knowledge = useMemo(
    () =>
      filterProfileScopedItems(knowledgeQuery.data ?? [], selectedProfileId),
    [knowledgeQuery.data, selectedProfileId]
  );
  const upload = useAtlasMutation(
    (
      atlas,
      input: {
        data: string;
        filename: string;
        mediaType: string;
        onDuplicate?: KnowledgeBaseDuplicateAction;
        profileId: string;
      }
    ) =>
      atlas.uploadKnowledgeBaseDocument(
        input.profileId,
        {
          data: input.data,
          filename: input.filename,
          mediaType: input.mediaType,
        },
        input.onDuplicate
      )
  );

  const uploadKnowledge = useCallback(() => {
    if (upload.isPending) {
      return;
    }
    if (!selectedProfile) {
      Alert.alert("No active profile found.");
      return;
    }
    const uploadProfileId = selectedProfile.id;
    void DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
    }).then(async (result) => {
      const asset = result.assets?.[0];
      if (!(asset && client)) {
        return;
      }
      if (!isKnowledgeBaseFilename(asset.name)) {
        Alert.alert(`Use ${KNOWLEDGE_BASE_SUPPORTED_TYPE_LABEL}.`);
        return;
      }
      try {
        await assertPickedDocumentSize(asset);
        const data = await fileToBase64(asset.uri);
        assertDocumentSize(data);
        await uploadKnowledgeBaseDocumentWithDuplicateResolution(asset.name, {
          decideDuplicate: decideKnowledgeBaseDuplicate,
          upload: (onDuplicate) =>
            upload.mutateAsync({
              data,
              filename: asset.name,
              mediaType: asset.mimeType ?? "application/octet-stream",
              onDuplicate,
              profileId: uploadProfileId,
            }),
        });
        await upload.queryClient.invalidateQueries({
          queryKey: queryKeys.knowledgeAll,
        });
        await upload.queryClient.invalidateQueries({
          queryKey: queryKeys.knowledge(uploadProfileId),
        });
      } catch (error) {
        Alert.alert(
          "Upload failed",
          error instanceof Error ? error.message : ""
        );
      }
    });
  }, [client, selectedProfile, upload]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight:
        tab === "knowledge" && selectedProfile
          ? () => (
              <HeaderAddButton
                accessibilityLabel="Upload knowledge"
                disabled={upload.isPending}
                onPress={uploadKnowledge}
              />
            )
          : undefined,
    });
  }, [navigation, selectedProfile, tab, uploadKnowledge, upload.isPending]);

  return (
    <RequireWorkspaceAdmin>
      <QueryState
        error={
          (tab === "artifacts" ? artifactsQuery.error : knowledgeQuery.error) ??
          profilesQuery.error
        }
        loading={
          tab === "artifacts"
            ? artifactsQuery.isLoading || profilesQuery.isLoading || isLoading
            : knowledgeQuery.isLoading || profilesQuery.isLoading || isLoading
        }
        onRetry={() => {
          void profilesQuery.refetch();
          if (tab === "artifacts") {
            void artifactsQuery.refetch();
            return;
          }
          void knowledgeQuery.refetch();
        }}
      >
        <Screen>
          <ProfileSelector
            disabled={upload.isPending}
            onSelect={selectProfile}
            profiles={profiles}
            selectedProfileId={selectedProfileId}
          />
          <Segmented
            onChange={setTab}
            options={[
              { label: "Files", value: "artifacts" },
              { label: "Knowledge", value: "knowledge" },
            ]}
            value={tab}
          />
          <ScrollView className="flex-1">
            {tab === "artifacts" ? (
              artifacts.length === 0 ? (
                <EmptyState
                  message={
                    selectedProfile
                      ? `No files for ${selectedProfile.name}.`
                      : "No profiles available."
                  }
                />
              ) : (
                artifacts.map((item) => (
                  <ListRow
                    key={`${item.profileId}:${item.path}`}
                    onPress={() =>
                      router.push({
                        params: { path: item.path, profileId: item.profileId },
                        pathname: "/artifact",
                      })
                    }
                    subtitle={fileSubtitle([
                      fileFolder(item.filename),
                      displayFileKind(item.filename, item.mimeType),
                      formatBytes(item.sizeBytes),
                    ])}
                    title={fileBasename(item.filename)}
                  />
                ))
              )
            ) : knowledge.length === 0 ? (
              <EmptyState
                message={
                  selectedProfile
                    ? `No knowledge documents for ${selectedProfile.name}.`
                    : "No profiles available."
                }
              />
            ) : (
              knowledge.map((item) => (
                <ListRow
                  key={`${item.profileId}:${item.id}`}
                  onPress={() =>
                    router.push({
                      params: {
                        documentId: item.id,
                        profileId: item.profileId,
                      },
                      pathname: "/knowledge",
                    })
                  }
                  subtitle={fileSubtitle([
                    displayFileKind(item.filename, item.mediaType),
                    item.status === "ready"
                      ? formatBytes(item.sizeBytes)
                      : item.status,
                  ])}
                  title={fileBasename(item.filename)}
                />
              ))
            )}
          </ScrollView>
        </Screen>
      </QueryState>
    </RequireWorkspaceAdmin>
  );
}
