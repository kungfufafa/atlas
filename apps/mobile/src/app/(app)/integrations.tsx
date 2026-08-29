import * as Clipboard from "expo-clipboard";
import { Stack } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { InlineForm } from "@/components/atlas/inline-form";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { SectionHeading } from "@/components/atlas/section-heading";
import { RequireIntegrationsAccess } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useServer } from "@/features/server/server-context";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import {
  useComposioToolkitsQuery,
  useIntegrationsQuery,
} from "@/hooks/use-workspace";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";
import { showMutationError } from "@/lib/mutation-error";
import { isSafeHttpUrl, openExternalUrl } from "@/lib/open-url";
import { queryKeys } from "@/lib/query-keys";

type ChannelKey = "composio" | "discord" | "telegram" | "whatsapp";

function channelSubtitle(configured: boolean, extra?: string | null): string {
  const status = configured ? "Connected" : "Not configured";
  return extra ? `${status} · ${extra}` : status;
}

export default function IntegrationsScreen() {
  const { activeServer } = useServer();
  const { isAdmin } = useWorkspaceAccess();
  const query = useIntegrationsQuery();
  const toolkitsQuery = useComposioToolkitsQuery();
  const [open, setOpen] = useState<ChannelKey | null>(null);
  const [telegramToken, setTelegramToken] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [composioKey, setComposioKey] = useState("");
  const saveTelegram = useAtlasMutation((client, botToken: string) =>
    client.setTelegramSettings({ botToken })
  );
  const saveDiscord = useAtlasMutation((client, botToken: string) =>
    client.setDiscordSettings({ botToken })
  );
  const saveComposio = useAtlasMutation((client, apiKey: string) =>
    client.setComposioSettings({ apiKey })
  );
  const pairWhatsApp = useAtlasMutation((client) =>
    client.regenerateWhatsAppPairingCode()
  );
  const reconnectWhatsApp = useAtlasMutation((client) =>
    client.reconnectWhatsApp()
  );
  const enableToolkit = useAtlasMutation((client, slug: string) =>
    client.enableComposioToolkit(slug)
  );
  const connectToolkit = useAtlasMutation((client, slug: string) =>
    client.connectComposioToolkit(slug, {
      callbackOrigin: activeServer?.url,
    })
  );

  const data = query.data;
  const pairingCode = data?.whatsapp.pairingCode;
  const enabledSlugs = new Set(
    (toolkitsQuery.data?.orgToolkits ?? []).map(
      (toolkit) => toolkit.toolkitSlug
    )
  );

  const toggle = (key: ChannelKey) => {
    if (!isAdmin) {
      return;
    }
    setOpen((current) => (current === key ? null : key));
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Integrations" }} />
      <RequireIntegrationsAccess>
        <QueryState
          error={query.error ?? toolkitsQuery.error}
          loading={query.isLoading || toolkitsQuery.isLoading}
          onRetry={() => {
            void query.refetch();
            void toolkitsQuery.refetch();
          }}
        >
          <Screen>
            <ScrollView keyboardShouldPersistTaps="handled">
              <ListRow
                onPress={isAdmin ? () => toggle("telegram") : undefined}
                subtitle={channelSubtitle(
                  data?.telegram.configured === true,
                  data?.telegram.handshakeCode
                    ? `Pairing ${data.telegram.handshakeCode}`
                    : data?.telegram.botTokenMasked
                )}
                title="Telegram"
              />
              {open === "telegram" && isAdmin ? (
                <InlineForm>
                  <Input
                    onChangeText={setTelegramToken}
                    placeholder="Bot token"
                    secureTextEntry
                    value={telegramToken}
                  />
                  <Button
                    onPress={() => {
                      void saveTelegram
                        .mutateAsync(telegramToken.trim())
                        .then(() => {
                          setTelegramToken("");
                          setOpen(null);
                          return saveTelegram.queryClient.invalidateQueries({
                            queryKey: queryKeys.integrations,
                          });
                        })
                        .catch((error: unknown) => {
                          showMutationError("Telegram", error);
                        });
                    }}
                  >
                    <Text>Save Telegram</Text>
                  </Button>
                </InlineForm>
              ) : null}

              <ListRow
                onPress={isAdmin ? () => toggle("whatsapp") : undefined}
                subtitle={channelSubtitle(
                  data?.whatsapp.configured === true,
                  pairingCode ?? data?.whatsapp.phoneNumberMasked
                )}
                title="WhatsApp"
              />
              {open === "whatsapp" && isAdmin ? (
                <View className="border-border border-b px-4 pb-4">
                  <ActionCluster>
                    {pairingCode ? (
                      <Button
                        onPress={() => {
                          void Clipboard.setStringAsync(pairingCode);
                        }}
                        size="sm"
                        variant="outline"
                      >
                        <Text>Copy code</Text>
                      </Button>
                    ) : null}
                    <Button
                      onPress={() => {
                        void pairWhatsApp
                          .mutateAsync(undefined)
                          .then(() =>
                            pairWhatsApp.queryClient.invalidateQueries({
                              queryKey: queryKeys.integrations,
                            })
                          )
                          .catch((error: unknown) => {
                            showMutationError("WhatsApp", error);
                          });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>{pairingCode ? "New code" : "Generate code"}</Text>
                    </Button>
                    <Button
                      onPress={() => {
                        void reconnectWhatsApp
                          .mutateAsync(undefined)
                          .then(() =>
                            reconnectWhatsApp.queryClient.invalidateQueries({
                              queryKey: queryKeys.integrations,
                            })
                          )
                          .catch((error: unknown) => {
                            showMutationError("WhatsApp", error);
                          });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>Reconnect</Text>
                    </Button>
                  </ActionCluster>
                </View>
              ) : null}

              <ListRow
                onPress={isAdmin ? () => toggle("discord") : undefined}
                subtitle={channelSubtitle(
                  data?.discord.configured === true,
                  data?.discord.handshakeCode ?? data?.discord.botTokenMasked
                )}
                title="Discord"
              />
              {open === "discord" && isAdmin ? (
                <InlineForm>
                  <Input
                    onChangeText={setDiscordToken}
                    placeholder="Bot token"
                    secureTextEntry
                    value={discordToken}
                  />
                  <Button
                    onPress={() => {
                      void saveDiscord
                        .mutateAsync(discordToken.trim())
                        .then(() => {
                          setDiscordToken("");
                          setOpen(null);
                          return saveDiscord.queryClient.invalidateQueries({
                            queryKey: queryKeys.integrations,
                          });
                        })
                        .catch((error: unknown) => {
                          showMutationError("Discord", error);
                        });
                    }}
                  >
                    <Text>Save Discord</Text>
                  </Button>
                </InlineForm>
              ) : null}

              <ListRow
                subtitle={channelSubtitle(
                  data?.email.configured === true,
                  data?.email.from
                )}
                title="Email"
              />

              <ListRow
                onPress={isAdmin ? () => toggle("composio") : undefined}
                subtitle={channelSubtitle(
                  data?.composio.configured === true,
                  data?.composio.apiKeyMasked
                )}
                title="Composio"
              />
              {open === "composio" && isAdmin ? (
                <InlineForm>
                  <Input
                    onChangeText={setComposioKey}
                    placeholder="Composio API key"
                    secureTextEntry
                    value={composioKey}
                  />
                  <Button
                    onPress={() => {
                      void saveComposio
                        .mutateAsync(composioKey.trim())
                        .then(async () => {
                          setComposioKey("");
                          setOpen(null);
                          await saveComposio.queryClient.invalidateQueries({
                            queryKey: queryKeys.integrations,
                          });
                          await saveComposio.queryClient.invalidateQueries({
                            queryKey: queryKeys.composioToolkits,
                          });
                        })
                        .catch((error: unknown) => {
                          showMutationError("Composio", error);
                        });
                    }}
                  >
                    <Text>Save Composio</Text>
                  </Button>
                </InlineForm>
              ) : null}

              {(toolkitsQuery.data?.orgToolkits ?? []).length > 0 ||
              (isAdmin && (toolkitsQuery.data?.catalog ?? []).length > 0) ? (
                <SectionHeading title="Toolkits" />
              ) : null}
              {(toolkitsQuery.data?.orgToolkits ?? []).map((toolkit) => (
                <ListRow
                  key={toolkit.id}
                  onPress={
                    isAdmin
                      ? () => {
                          void connectToolkit
                            .mutateAsync(toolkit.toolkitSlug)
                            .then(async (response) => {
                              if (!isSafeHttpUrl(response.redirectUrl)) {
                                throw new Error("Unsafe OAuth URL.");
                              }
                              await openExternalUrl(response.redirectUrl);
                              await connectToolkit.queryClient.invalidateQueries(
                                {
                                  queryKey: queryKeys.composioToolkits,
                                }
                              );
                            })
                            .catch((error: unknown) => {
                              showMutationError("Composio", error);
                            });
                        }
                      : undefined
                  }
                  subtitle={toolkit.status}
                  title={toolkit.displayName}
                />
              ))}
              {isAdmin
                ? (toolkitsQuery.data?.catalog ?? [])
                    .filter((toolkit) => !enabledSlugs.has(toolkit.slug))
                    .slice(0, 12)
                    .map((toolkit) => (
                      <ListRow
                        key={toolkit.slug}
                        onPress={() => {
                          void enableToolkit
                            .mutateAsync(toolkit.slug)
                            .then(() =>
                              enableToolkit.queryClient.invalidateQueries({
                                queryKey: queryKeys.composioToolkits,
                              })
                            )
                            .catch((error: unknown) => {
                              showMutationError("Composio", error);
                            });
                        }}
                        showChevron={false}
                        title={toolkit.name}
                        value="Enable"
                      />
                    ))
                : null}
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireIntegrationsAccess>
    </>
  );
}
