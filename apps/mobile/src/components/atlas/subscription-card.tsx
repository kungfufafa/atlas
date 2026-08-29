import type { SubscriptionProviderKind } from "@atlas/core/contract";
import { useState } from "react";
import { Alert, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useServer } from "@/features/server/server-context";
import { useReadyAtlasClient } from "@/hooks/use-atlas-query";
import { useSubscriptionAuthQuery } from "@/hooks/use-workspace";
import { openExternalUrl } from "@/lib/open-url";

function SubscriptionCard({ kind }: { kind: SubscriptionProviderKind }) {
  const client = useReadyAtlasClient();
  const { activeServer, isCurrentServer } = useServer();
  const sourceServerId = activeServer?.id ?? null;
  const query = useSubscriptionAuthQuery(kind);
  const [busy, setBusy] = useState(false);
  const state = query.data;
  const label = kind === "chatgpt" ? "ChatGPT" : "Claude";

  const connect = async () => {
    if (!(client && isCurrentServer(sourceServerId))) {
      return;
    }
    setBusy(true);
    try {
      const started = await client.startSubscriptionLogin(kind);
      if (!isCurrentServer(sourceServerId)) {
        return;
      }
      const url = started.authUrl ?? started.verificationUrl;
      if (url) {
        await openExternalUrl(url);
      }
      for (let attempt = 0; attempt < 45; attempt += 1) {
        if (!isCurrentServer(sourceServerId)) {
          return;
        }
        const status = await client.getSubscriptionLoginStatus(
          kind,
          started.loginId
        );
        if (!isCurrentServer(sourceServerId)) {
          return;
        }
        if (status.status === "completed") {
          await query.refetch();
          return;
        }
        if (status.status === "failed" || status.status === "cancelled") {
          throw new Error(status.error ?? "Subscription login failed.");
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error) {
      if (isCurrentServer(sourceServerId)) {
        Alert.alert(
          label,
          error instanceof Error ? error.message : "Could not connect."
        );
      }
    } finally {
      if (isCurrentServer(sourceServerId)) {
        setBusy(false);
      }
    }
  };

  const logout = async () => {
    if (!(client && isCurrentServer(sourceServerId))) {
      return;
    }
    setBusy(true);
    try {
      await client.logoutSubscription(kind);
      if (!isCurrentServer(sourceServerId)) {
        return;
      }
      await query.refetch();
    } catch (error) {
      if (isCurrentServer(sourceServerId)) {
        Alert.alert(
          label,
          error instanceof Error ? error.message : "Could not disconnect."
        );
      }
    } finally {
      if (isCurrentServer(sourceServerId)) {
        setBusy(false);
      }
    }
  };

  return (
    <View className="flex-row items-center border-border border-b px-4 py-3">
      <View className="min-w-0 flex-1 pr-3">
        <Text className="font-heading" numberOfLines={1}>
          {label}
        </Text>
        <Text className="mt-1 text-muted-foreground text-sm" numberOfLines={1}>
          {state?.authenticated
            ? (state.email ?? "Connected")
            : "Not connected"}
        </Text>
      </View>
      <Button
        disabled={busy}
        onPress={() => {
          void (state?.authenticated ? logout() : connect());
        }}
        size="sm"
        variant="outline"
      >
        <Text>
          {busy ? "Working…" : state?.authenticated ? "Disconnect" : "Connect"}
        </Text>
      </Button>
    </View>
  );
}

export { SubscriptionCard };
