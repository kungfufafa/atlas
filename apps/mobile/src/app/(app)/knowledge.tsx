import { Image } from "expo-image";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { MarkdownView } from "@/components/atlas/markdown";
import { Screen } from "@/components/atlas/screen";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { formatBytes } from "@/features/chat/chat-items";
import { useAtlasMutation, useReadyAtlasClient } from "@/hooks/use-atlas-query";
import { confirmDestructive } from "@/lib/confirm";
import {
  displayFileKind,
  fileBasename,
  isImagePreviewable,
  isMarkdownFile,
  isTextPreviewable,
} from "@/lib/file-display";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { shareBinaryFile, writeCacheFile } from "@/lib/share-file";

function decodeText(data: ArrayBuffer): string {
  return new TextDecoder().decode(data);
}

export default function KnowledgeDocumentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    documentId?: string;
    profileId?: string;
  }>();
  const profileId = String(params.profileId ?? "");
  const documentId = String(params.documentId ?? "");
  const client = useReadyAtlasClient();
  const [filename, setFilename] = useState("Document");
  const [mimeType, setMimeType] = useState("");
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setFilename("Document");
    setMimeType("");
    setBytes(null);
    setContent(null);
    setImageUri(null);
    setError(null);

    if (!(client && profileId && documentId)) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void client
      .listKnowledgeBase(profileId)
      .then(async (response) => {
        const document = response.documents.find(
          (item) => item.id === documentId
        );
        if (!document) {
          throw new Error("Document not found.");
        }
        if (cancelled) {
          return;
        }
        setFilename(document.filename);
        const raw = await client.readKnowledgeBaseDocumentContent(
          profileId,
          documentId,
          { inline: true }
        );
        if (cancelled) {
          return;
        }
        setBytes(raw.data);
        setMimeType(raw.contentType || document.mediaType);
        const type = raw.contentType || document.mediaType;
        if (isImagePreviewable(document.filename, type)) {
          setImageUri(await writeCacheFile(document.filename, raw.data));
        } else if (isTextPreviewable(document.filename, type)) {
          setContent(decodeText(raw.data));
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not open document."
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, documentId, profileId]);

  const remove = useAtlasMutation((atlas) =>
    atlas.deleteKnowledgeBaseDocument(profileId, documentId)
  );

  const openExternally = async () => {
    if (!bytes) {
      return;
    }
    try {
      await shareBinaryFile(filename, bytes, mimeType);
    } catch (caught: unknown) {
      Alert.alert(
        "Could not open file",
        caught instanceof Error ? caught.message : ""
      );
    }
  };

  const name = fileBasename(filename);
  const showText = content != null && !imageUri;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: name }} />
      <Screen padded>
        {loading ? <Spinner className="flex-1" /> : null}
        {error ? <Text className="text-destructive">{error}</Text> : null}
        {loading || error ? null : (
          <ScrollView keyboardShouldPersistTaps="handled">
            <View className="gap-3 pb-8">
              <Text className="text-muted-foreground">
                {displayFileKind(filename, mimeType)}
                {bytes ? ` · ${formatBytes(bytes.byteLength)}` : ""}
              </Text>
              <ActionCluster>
                <Button
                  onPress={() => {
                    void openExternally();
                  }}
                  size="sm"
                >
                  <Text>Share</Text>
                </Button>
                <Button
                  disabled={remove.isPending}
                  onPress={() => {
                    confirmDestructive({
                      message: name,
                      onConfirm: () => {
                        void remove
                          .mutateAsync(undefined)
                          .then(async () => {
                            await remove.queryClient.invalidateQueries({
                              queryKey: queryKeys.knowledgeAll,
                            });
                            await remove.queryClient.invalidateQueries({
                              queryKey: queryKeys.knowledge(profileId),
                            });
                            router.back();
                          })
                          .catch((error: unknown) => {
                            showMutationError(
                              "Could not delete document",
                              error
                            );
                          });
                      },
                      title: "Delete document",
                    });
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Text>{remove.isPending ? "Deleting…" : "Delete"}</Text>
                </Button>
              </ActionCluster>
              {imageUri ? (
                <Image
                  contentFit="contain"
                  source={{ uri: imageUri }}
                  style={{ height: 360, width: "100%" }}
                />
              ) : null}
              {showText && isMarkdownFile(filename) ? (
                <MarkdownView text={content ?? ""} />
              ) : null}
              {showText && !isMarkdownFile(filename) ? (
                <Text className="font-mono text-sm" selectable>
                  {content}
                </Text>
              ) : null}
            </View>
          </ScrollView>
        )}
      </Screen>
    </>
  );
}
