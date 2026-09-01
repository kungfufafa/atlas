import type { DocumentAttachment, ImageAttachment } from "@atlas/core/contract";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@atlas/core/message-content-limits";
import {
  Attachment01Icon,
  Cancel01Icon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { Text } from "@/components/ui/text";
import type { ChatSendInput } from "@/features/chat/use-chat-session";
import { useAppTheme } from "@/features/theme/theme-provider";
import {
  assertDocumentSize,
  compressImageAttachment,
} from "@/lib/compress-image";
import { resolvePickedImageMediaType } from "@/lib/image-media-type";
import { assertPickedDocumentSize } from "@/lib/picked-file-size";
import { NAV_THEME } from "@/lib/theme";
import { cn } from "@/lib/utils";

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

function pickAttachmentKind(): Promise<"file" | "photo" | null> {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    if (window.confirm("Attach a photo from your library?")) {
      return Promise.resolve("photo");
    }
    if (window.confirm("Attach a file?")) {
      return Promise.resolve("file");
    }
    return Promise.resolve(null);
  }

  if (Platform.OS === "ios") {
    return new Promise((resolve) => {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          cancelButtonIndex: 2,
          options: ["Photo", "File", "Cancel"],
        },
        (index) => {
          if (index === 0) {
            resolve("photo");
            return;
          }
          if (index === 1) {
            resolve("file");
            return;
          }
          resolve(null);
        }
      );
    });
  }

  return new Promise((resolve) => {
    Alert.alert("Attach", undefined, [
      { onPress: () => resolve("photo"), text: "Photo" },
      { onPress: () => resolve("file"), text: "File" },
      { onPress: () => resolve(null), style: "cancel", text: "Cancel" },
    ]);
  });
}

function ChatComposer({
  disabled,
  isSending,
  onSend,
  onStop,
  sticky = true,
}: {
  disabled?: boolean;
  isSending: boolean;
  onSend: (input: ChatSendInput) => void;
  onStop: () => void;
  sticky?: boolean;
}) {
  const { resolved } = useAppTheme();
  const colors = NAV_THEME[resolved].colors;
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const attachmentCount = images.length + documents.length;
  const canAttach = !disabled && attachmentCount < MAX_ATTACHMENTS_PER_MESSAGE;
  const canSend = !disabled && (text.trim().length > 0 || attachmentCount > 0);

  const submit = () => {
    const next = text.trim();
    if ((!next && attachmentCount === 0) || disabled) {
      return;
    }
    setText("");
    setImages([]);
    setDocuments([]);
    onSend({
      documents: documents.length > 0 ? documents : undefined,
      images: images.length > 0 ? images : undefined,
      message: next,
    });
  };

  const attachPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      base64: true,
      mediaTypes: ["images"],
      quality: 0.7,
    });
    const asset = result.assets?.[0];
    if (!asset?.base64) {
      return;
    }
    const compressed = await compressImageAttachment({
      data: asset.base64,
      height: asset.height,
      mediaType: resolvePickedImageMediaType(
        asset.base64,
        asset.mimeType ?? "image/jpeg"
      ),
      uri: asset.uri,
      width: asset.width,
    });
    setImages((current) => [
      ...current,
      {
        data: compressed.data,
        mediaType: compressed.mediaType,
      },
    ]);
  };

  const attachFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
    });
    const asset = result.assets?.[0];
    if (!asset) {
      return;
    }
    await assertPickedDocumentSize(asset);
    const data = await fileToBase64(asset.uri);
    assertDocumentSize(data);
    setDocuments((current) => [
      ...current,
      {
        data,
        filename: asset.name,
        mediaType: asset.mimeType ?? "application/octet-stream",
      },
    ]);
  };

  const content = (
    <View className="bg-background px-4 py-3">
      <View className="rounded-xl border border-border bg-card p-2.5 shadow-sm">
        {attachmentCount > 0 ? (
          <View className="mb-2 flex-row flex-wrap gap-2 border-border border-b pb-2">
            {images.map((_, index) => (
              <Pressable
                accessibilityLabel={`Remove photo ${index + 1}`}
                accessibilityRole="button"
                className="rounded-full bg-secondary px-2.5 py-1"
                key={`image-${index}`}
                onPress={() => {
                  setImages((current) =>
                    current.filter((_, currentIndex) => currentIndex !== index)
                  );
                }}
              >
                <Text className="text-muted-foreground text-xs">Photo ×</Text>
              </Pressable>
            ))}
            {documents.map((document, index) => (
              <Pressable
                accessibilityLabel={`Remove ${document.filename}`}
                accessibilityRole="button"
                className="rounded-full bg-secondary px-2.5 py-1"
                key={`${document.filename}-${index}`}
                onPress={() => {
                  setDocuments((current) =>
                    current.filter((_, currentIndex) => currentIndex !== index)
                  );
                }}
              >
                <Text className="text-muted-foreground text-xs">
                  {document.filename} ×
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <TextInput
          accessibilityLabel="Message"
          className="max-h-32 min-h-11 px-1 py-1.5 font-sans text-base text-foreground leading-6"
          editable={!disabled}
          multiline
          onChangeText={setText}
          placeholder="Do anything..."
          placeholderClassName="text-muted-foreground"
          textAlignVertical="center"
          value={text}
        />
        <View className="mt-1.5 flex-row items-center justify-between">
          <Pressable
            accessibilityLabel="Attach"
            accessibilityRole="button"
            accessibilityState={{ disabled: !canAttach }}
            className={cn(
              "h-11 w-11 items-center justify-center rounded-full bg-secondary",
              !canAttach && "opacity-40"
            )}
            disabled={!canAttach}
            onPress={() => {
              void pickAttachmentKind()
                .then(async (kind) => {
                  if (kind === "photo") {
                    await attachPhoto();
                    return;
                  }
                  if (kind === "file") {
                    await attachFile();
                  }
                })
                .catch((error: unknown) => {
                  Alert.alert(
                    "Could not attach",
                    error instanceof Error ? error.message : ""
                  );
                });
            }}
          >
            <HugeiconsIcon
              color={colors.text}
              icon={Attachment01Icon}
              size={18}
            />
          </Pressable>
          {isSending && !disabled ? (
            <Pressable
              accessibilityLabel="Stop"
              accessibilityRole="button"
              className="h-11 w-11 items-center justify-center rounded-full bg-destructive"
              onPress={onStop}
            >
              <HugeiconsIcon color="#fff" icon={Cancel01Icon} size={14} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel="Send"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend }}
              className={cn(
                "h-11 w-11 items-center justify-center rounded-full bg-primary",
                !canSend && "opacity-40"
              )}
              disabled={!canSend}
              onPress={submit}
            >
              <HugeiconsIcon color="#fff" icon={SentIcon} size={15} />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );

  if (!sticky) {
    return content;
  }

  return (
    <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
      {content}
    </KeyboardStickyView>
  );
}

export { ChatComposer };
