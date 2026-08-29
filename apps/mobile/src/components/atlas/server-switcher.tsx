import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useServer } from "@/features/server/server-context";
import { confirmServerRemoval } from "@/lib/confirm";
import { cn } from "@/lib/utils";

interface ServerSwitcherProps {
  disabled?: boolean;
  onBeforeChange?: () => void;
  onSelect?: () => void;
}

function ServerSwitcher({
  disabled = false,
  onBeforeChange,
  onSelect,
}: ServerSwitcherProps) {
  const { activeServer, removeServer, servers, setActiveServer } = useServer();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const isPending = disabled || pendingId !== null;

  const showError = (title: string, error: unknown) => {
    Alert.alert(
      title,
      error instanceof Error ? error.message : "Please try again."
    );
  };

  const selectServer = (id: string) => {
    if (isPending) {
      return;
    }
    onBeforeChange?.();
    if (id === activeServer?.id) {
      onSelect?.();
      return;
    }

    setPendingId(id);
    void setActiveServer(id)
      .then(() => onSelect?.())
      .catch((error: unknown) => showError("Could not switch server", error))
      .finally(() => setPendingId(null));
  };

  const remove = (id: string, name: string) => {
    if (isPending) {
      return;
    }

    onBeforeChange?.();
    confirmServerRemoval({
      isActive: id === activeServer?.id,
      isLast: servers.length === 1,
      name,
      onConfirm: () => {
        setPendingId(id);
        void removeServer(id)
          .catch((error: unknown) =>
            showError("Could not remove server", error)
          )
          .finally(() => setPendingId(null));
      },
    });
  };

  return (
    <View className="gap-2">
      {servers.map((server) => {
        const selected = server.id === activeServer?.id;
        return (
          <View
            className={cn(
              "rounded-lg border border-border",
              selected && "border-primary bg-accent"
            )}
            key={server.id}
          >
            <Pressable
              accessibilityLabel={`Use ${server.name}`}
              className="px-3 py-3"
              disabled={isPending}
              onPress={() => {
                selectServer(server.id);
              }}
            >
              <Text className="font-medium">{server.name}</Text>
              <Text className="font-mono text-muted-foreground text-sm">
                {server.url}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`Remove ${server.name}`}
              className="border-border border-t px-3 py-2"
              disabled={isPending}
              onPress={() => {
                remove(server.id, server.name);
              }}
            >
              <Text className="text-destructive text-sm">
                {pendingId === server.id ? "Working…" : "Remove"}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

export { ServerSwitcher };
