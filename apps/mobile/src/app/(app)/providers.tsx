import type { CreateProviderRequest } from "@atlas/core/contract";
import { Stack, useNavigation } from "expo-router";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { EmptyState } from "@/components/atlas/empty-state";
import { HeaderAddButton } from "@/components/atlas/header-add-button";
import { InlineForm } from "@/components/atlas/inline-form";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { SubscriptionCard } from "@/components/atlas/subscription-card";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { mobileSetupProviders } from "@/features/setup/mobile-providers";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useProvidersQuery } from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

export default function ProvidersScreen() {
  const navigation = useNavigation();
  const query = useProvidersQuery();
  const providers = useMemo(() => mobileSetupProviders(), []);
  const [creating, setCreating] = useState(false);
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "openai");
  const [apiKey, setApiKey] = useState("");
  const selected =
    providers.find((provider) => provider.id === providerId) ?? providers[0];
  const [model, setModel] = useState(selected?.fallbackModelId ?? "");
  const modelTrimmed = model.trim();
  const hasModel = modelTrimmed.length > 0;
  const isApiKeyRequired = selected?.apiKey.requirement === "required";

  const create = useAtlasMutation((client, request: CreateProviderRequest) =>
    client.createProvider(request)
  );
  const remove = useAtlasMutation((client, providerKey: string) =>
    client.deleteProvider(providerKey)
  );

  useEffect(() => {
    setModel(selected?.fallbackModelId ?? "");
  }, [selected?.fallbackModelId]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderAddButton
          accessibilityLabel="Add provider"
          disabled={create.isPending || remove.isPending}
          onPress={() => setCreating((current) => !current)}
        />
      ),
    });
  }, [create.isPending, navigation, remove.isPending]);

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Providers" }} />
      <RequireWorkspaceAdmin>
        <QueryState
          error={query.error}
          loading={query.isLoading}
          onRetry={() => {
            void query.refetch();
          }}
        >
          <Screen className="px-0">
            <ScrollView keyboardShouldPersistTaps="handled">
              <SubscriptionCard kind="chatgpt" />
              <SubscriptionCard kind="claude" />
              {creating ? (
                <InlineForm>
                  <View className="flex-row flex-wrap gap-2">
                    {providers.map((provider) => (
                      <Pressable
                        className={cn(
                          "rounded-full border border-border px-3 py-2",
                          provider.id === providerId &&
                            "border-primary bg-accent"
                        )}
                        key={provider.id}
                        onPress={() => {
                          setProviderId(provider.id);
                          setModel(provider.fallbackModelId);
                        }}
                      >
                        <Text>{provider.displayName}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Input
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setApiKey}
                    placeholder="API key"
                    secureTextEntry
                    value={apiKey}
                  />
                  <Input
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setModel}
                    placeholder={`Model (default: ${selected?.fallbackModelId})`}
                    value={model}
                  />
                  <Button
                    disabled={
                      create.isPending || (isApiKeyRequired && !apiKey.trim())
                    }
                    onPress={() => {
                      void create
                        .mutateAsync({
                          apiKey: apiKey.trim(),
                          model: hasModel
                            ? modelTrimmed
                            : selected?.fallbackModelId,
                          type: providerId,
                        } as CreateProviderRequest)
                        .then(async () => {
                          setApiKey("");
                          setModel(selected?.fallbackModelId ?? "");
                          setCreating(false);
                          await create.queryClient.invalidateQueries({
                            queryKey: queryKeys.providers,
                          });
                        })
                        .catch((error: unknown) => {
                          showMutationError("Could not add provider", error);
                        });
                    }}
                  >
                    <Text>
                      {create.isPending ? "Adding provider…" : "Add provider"}
                    </Text>
                  </Button>
                </InlineForm>
              ) : null}
              {(query.data?.providers ?? []).length === 0 ? (
                <EmptyState message="No providers yet." />
              ) : (
                (query.data?.providers ?? []).map((provider) => (
                  <ListRow
                    key={provider.id}
                    right={
                      <Button
                        disabled={remove.isPending}
                        onPress={() => {
                          confirmDestructive({
                            confirmLabel: "Remove",
                            message: provider.label,
                            onConfirm: () => {
                              void remove
                                .mutateAsync(provider.id)
                                .then(() =>
                                  remove.queryClient.invalidateQueries({
                                    queryKey: queryKeys.providers,
                                  })
                                )
                                .catch((error: unknown) => {
                                  showMutationError(
                                    "Could not remove provider",
                                    error
                                  );
                                });
                            },
                            title: "Remove provider",
                          });
                        }}
                        size="sm"
                        variant="outline"
                      >
                        <Text>{remove.isPending ? "Removing…" : "Remove"}</Text>
                      </Button>
                    }
                    subtitle={provider.type}
                    title={provider.label}
                  />
                ))
              )}
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
