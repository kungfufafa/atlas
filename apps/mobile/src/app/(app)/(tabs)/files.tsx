import * as DocumentPicker from "expo-document-picker";
import { useNavigation, useRouter } from "expo-router";
import { useCallback, useLayoutEffect, useState } from "react";
import { Alert, ScrollView } from "react-native";
import { EmptyState } from "@/components/atlas/empty-state";
import { HeaderAddButton } from "@/components/atlas/header-add-button";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { Segmented } from "@/components/atlas/segmented";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { formatBytes } from "@/features/chat/chat-items";
import { useAtlasMutation, useReadyAtlasClient } from "@/hooks/use-atlas-query";
import { useProfilesQuery } from "@/hooks/use-profiles";
import {
  useAllArtifactsQuery,
  useAllKnowledgeQuery,
} from "@/hooks/use-workspace";
import { assertDocumentSize } from "@/lib/compress-image";
import { displayFileKind, fileBasename, fileFolder } from "@/lib/file-display";
import { isKnowledgeBaseFilename } from "@/lib/kb-files";
import { assertPickedDocumentSize } from "@/lib/picked-file-size";
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

export default function FilesScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const client = useReadyAtlasClient();
  const [tab, setTab] = useState<FilesTab>("artifacts");
  const artifactsQuery = useAllArtifactsQuery();
  const knowledgeQuery = useAllKnowledgeQuery();
  const profilesQuery = useProfilesQuery();
  const profile =
    profilesQuery.data?.find((item) => item.isDefault) ??
    profilesQuery.data?.[0];
  const upload = useAtlasMutation(
    (atlas, input: { data: string; filename: string; mediaType: string }) =>
      atlas.uploadKnowledgeBaseDocument(profile?.id ?? "", {
        data: input.data,
        filename: input.filename,
        mediaType: input.mediaType,
      })
  );

  const uploadKnowledge = useCallback(() => {
    if (upload.isPending) {
      return;
    }
    if (!profile) {
      Alert.alert("No active profile found.");
      return;
    }
    void DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
    }).then(async (result) => {
      const asset = result.assets?.[0];
      if (!(asset && client)) {
        return;
      }
      if (!isKnowledgeBaseFilename(asset.name)) {
        Alert.alert("Use txt, md, csv, pdf, or docx.");
        return;
      }
      try {
        await assertPickedDocumentSize(asset);
        const data = await fileToBase64(asset.uri);
        assertDocumentSize(data);
        await upload.mutateAsync({
          data,
          filename: asset.name,
          mediaType: asset.mimeType ?? "application/octet-stream",
        });
        await upload.queryClient.invalidateQueries({
          queryKey: queryKeys.knowledgeAll,
        });
        await upload.queryClient.invalidateQueries({
          queryKey: queryKeys.knowledge(profile.id),
        });
      } catch (error) {
        Alert.alert(
          "Upload failed",
          error instanceof Error ? error.message : ""
        );
      }
    });
  }, [client, profile, upload]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight:
        tab === "knowledge"
          ? () => (
              <HeaderAddButton
                accessibilityLabel="Upload knowledge"
                disabled={upload.isPending}
                onPress={uploadKnowledge}
              />
            )
          : undefined,
    });
  }, [navigation, tab, uploadKnowledge, upload.isPending]);

  return (
    <RequireWorkspaceAdmin>
      <QueryState
        error={
          (tab === "artifacts" ? artifactsQuery.error : knowledgeQuery.error) ??
          profilesQuery.error
        }
        loading={
          tab === "artifacts"
            ? artifactsQuery.isLoading || profilesQuery.isLoading
            : knowledgeQuery.isLoading || profilesQuery.isLoading
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
              (artifactsQuery.data ?? []).length === 0 ? (
                <EmptyState message="No files yet." />
              ) : (
                (artifactsQuery.data ?? []).map((item) => (
                  <ListRow
                    key={`${item.profileId}:${item.path}`}
                    onPress={() =>
                      router.push({
                        params: { path: item.path, profileId: item.profileId },
                        pathname: "/artifact",
                      })
                    }
                    subtitle={fileSubtitle([
                      item.profileName,
                      fileFolder(item.filename),
                      displayFileKind(item.filename, item.mimeType),
                      formatBytes(item.sizeBytes),
                    ])}
                    title={fileBasename(item.filename)}
                  />
                ))
              )
            ) : (knowledgeQuery.data ?? []).length === 0 ? (
              <EmptyState message="No knowledge documents." />
            ) : (
              (knowledgeQuery.data ?? []).map((item) => (
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
                    item.profileName,
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
