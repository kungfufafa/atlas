import * as Clipboard from "expo-clipboard";
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
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/features/auth/auth-context";
import { formatBytes } from "@/features/chat/chat-items";
import { useAtlasMutation, useReadyAtlasClient } from "@/hooks/use-atlas-query";
import { confirmDestructive } from "@/lib/confirm";
import {
  displayFileKind,
  fileBasename,
  isEditableFile,
  isImagePreviewable,
  isMarkdownFile,
  isTextPreviewable,
} from "@/lib/file-display";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { isWorkspaceAdmin } from "@/lib/roles";
import { shareBinaryFile, writeCacheFile } from "@/lib/share-file";

function decodeText(data: ArrayBuffer): string {
  return new TextDecoder().decode(data);
}

export default function ArtifactScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ path?: string; profileId?: string }>();
  const profileId = String(params.profileId ?? "");
  const path = String(params.path ?? "");
  const filename = fileBasename(path);
  const { activeOrg, user } = useAuth();
  const client = useReadyAtlasClient();
  const admin = isWorkspaceAdmin({
    activeOrg,
    isPlatformAdmin: user?.isPlatformAdmin,
  });
  const [content, setContent] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [mimeType, setMimeType] = useState("");
  const [hash, setHash] = useState("");
  const [editable, setEditable] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setBytes(null);
    setMimeType("");
    setHash("");
    setEditable(false);
    setImageUri(null);
    setError(null);
    setShareUrl(null);
    setShareId(null);

    if (!(client && profileId && path)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      let text: string | null = null;
      if (isEditableFile(filename)) {
        try {
          const editableArtifact = await client.getEditableProfileArtifact(
            profileId,
            path
          );
          if (cancelled) {
            return;
          }
          setHash(editableArtifact.expectedHash);
          setEditable(Boolean(editableArtifact.editable));
          if (editableArtifact.content != null) {
            text = editableArtifact.content;
            setContent(editableArtifact.content);
          }
        } catch {
          setEditable(false);
        }
      }

      if (text == null) {
        const raw = await client.readProfileArtifactContent(profileId, path, {
          inline: true,
        });
        if (cancelled) {
          return;
        }
        setBytes(raw.data);
        setMimeType(raw.contentType);
        if (isImagePreviewable(filename, raw.contentType)) {
          setImageUri(await writeCacheFile(filename, raw.data));
        } else if (isTextPreviewable(filename, raw.contentType)) {
          setContent(decodeText(raw.data));
        }
      }

      if (cancelled) {
        return;
      }
      const share = await client.getProfileArtifactShareStatus(profileId, path);
      if (cancelled) {
        return;
      }
      setShareUrl(share?.shareUrl ?? null);
      setShareId(share?.active ? share.id : null);
    };

    void load()
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : "Could not open file."
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
  }, [client, filename, path, profileId]);

  const save = useAtlasMutation(
    (atlas, input: { content: string; expectedHash: string }) =>
      atlas.updateEditableProfileArtifact(profileId, path, input)
  );
  const remove = useAtlasMutation((atlas) =>
    atlas.deleteProfileArtifact(profileId, path)
  );
  const publishShare = useAtlasMutation((atlas) =>
    atlas.publishProfileArtifactShare(profileId, path)
  );
  const revokeShare = useAtlasMutation((atlas, id: string) =>
    atlas.revokeProfileArtifactShare(profileId, id)
  );

  const openExternally = async () => {
    if (!(client && profileId && path)) {
      return;
    }
    try {
      const data =
        bytes ??
        (
          await client.readProfileArtifactContent(profileId, path, {
            inline: true,
          })
        ).data;
      await shareBinaryFile(filename, data, mimeType);
    } catch (caught: unknown) {
      Alert.alert(
        "Could not open file",
        caught instanceof Error ? caught.message : ""
      );
    }
  };

  const fileKind = displayFileKind(filename, mimeType);
  const showText = content != null && !imageUri;
  const binaryOnly = !(showText || imageUri || loading || error);

  return (
    <>
      <Stack.Screen
        options={{ headerShown: true, title: filename || "File" }}
      />
      <Screen padded>
        {loading ? <Spinner className="flex-1" /> : null}
        {error ? <Text className="text-destructive">{error}</Text> : null}
        {loading || error ? null : (
          <ScrollView keyboardShouldPersistTaps="handled">
            <View className="gap-3 pb-8">
              <Text className="text-muted-foreground">
                {fileKind}
                {binaryOnly && bytes
                  ? ` · ${formatBytes(bytes.byteLength)}`
                  : ""}
              </Text>
              <ActionCluster>
                {admin && editable && content != null ? (
                  <Button
                    onPress={() => {
                      void save
                        .mutateAsync({ content, expectedHash: hash })
                        .then((response) => {
                          setHash(response.expectedHash);
                          setContent(response.content ?? content);
                        })
                        .catch((caught: unknown) => {
                          showMutationError("Could not save", caught);
                        });
                    }}
                    size="sm"
                  >
                    <Text>Save</Text>
                  </Button>
                ) : null}
                <Button
                  onPress={() => {
                    void openExternally();
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Text>Share</Text>
                </Button>
                {admin ? (
                  <Button
                    onPress={() => {
                      if (shareId) {
                        void revokeShare
                          .mutateAsync(shareId)
                          .then(() => {
                            setShareId(null);
                            setShareUrl(null);
                          })
                          .catch((error: unknown) => {
                            showMutationError("Could not revoke link", error);
                          });
                        return;
                      }
                      void publishShare
                        .mutateAsync(undefined)
                        .then(async (response) => {
                          setShareId(response.id);
                          setShareUrl(response.shareUrl);
                          if (response.shareUrl) {
                            await Clipboard.setStringAsync(response.shareUrl);
                          }
                        })
                        .catch((caught: unknown) => {
                          showMutationError("Could not share", caught);
                        });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>{shareId ? "Revoke link" : "Copy link"}</Text>
                  </Button>
                ) : null}
                {admin ? (
                  <Button
                    onPress={() => {
                      confirmDestructive({
                        message: filename,
                        onConfirm: () => {
                          void remove
                            .mutateAsync(undefined)
                            .then(async () => {
                              await remove.queryClient.invalidateQueries({
                                queryKey: queryKeys.artifacts(profileId),
                              });
                              await remove.queryClient.invalidateQueries({
                                queryKey: queryKeys.artifactsAll,
                              });
                              router.back();
                            })
                            .catch((error: unknown) => {
                              showMutationError("Could not delete file", error);
                            });
                        },
                        title: "Delete file",
                      });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>Delete</Text>
                  </Button>
                ) : null}
              </ActionCluster>
              {shareUrl ? (
                <Text className="text-muted-foreground text-sm" selectable>
                  {shareUrl}
                </Text>
              ) : null}
              {imageUri ? (
                <Image
                  contentFit="contain"
                  source={{ uri: imageUri }}
                  style={{ height: 360, width: "100%" }}
                />
              ) : null}
              {showText && editable ? (
                <Textarea
                  className="min-h-40"
                  editable={admin}
                  onChangeText={setContent}
                  value={content ?? ""}
                />
              ) : null}
              {showText && !editable && isMarkdownFile(filename) ? (
                <MarkdownView text={content ?? ""} />
              ) : null}
              {showText && !editable && !isMarkdownFile(filename) ? (
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
