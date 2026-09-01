import { formatError } from "@atlas/client";
import type {
  CreateProviderRequest,
  ProviderInstanceSummary,
  TestProviderRequest,
  UpdateProviderRequest,
} from "@atlas/core/contract";
import { isSubscriptionProvider } from "@atlas/core/provider-catalog";
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
import {
  buildProviderTestRequest,
  buildProviderUpdateRequest,
  type ProviderEditDraft,
  validateProviderConnectionTest,
  validateProviderEdit,
} from "@/lib/provider-edit";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

export default function ProvidersScreen() {
  const navigation = useNavigation();
  const query = useProvidersQuery();
  const providers = useMemo(() => mobileSetupProviders(), []);
  const [creating, setCreating] = useState(false);
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "openai");
  const [apiKey, setApiKey] = useState("");
  const [editingProviderId, setEditingProviderId] = useState<string | null>(
    null
  );
  const [editLabel, setEditLabel] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(
    null
  );
  const [removingProviderId, setRemovingProviderId] = useState<string | null>(
    null
  );
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
  const update = useAtlasMutation(
    (client, input: { providerId: string; request: UpdateProviderRequest }) =>
      client.updateProvider(input.providerId, input.request)
  );
  const testConnection = useAtlasMutation(
    (client, request: TestProviderRequest) => client.testProvider(request)
  );
  const providerMutationPending =
    create.isPending ||
    remove.isPending ||
    update.isPending ||
    testConnection.isPending;

  useEffect(() => {
    setModel(selected?.fallbackModelId ?? "");
  }, [selected?.fallbackModelId]);

  const clearEditFeedback = () => {
    setEditError(null);
    setTestMessage(null);
  };

  const closeEdit = () => {
    setEditingProviderId(null);
    setEditLabel("");
    setEditBaseUrl("");
    setEditApiKey("");
    clearEditFeedback();
  };

  const openEdit = (provider: ProviderInstanceSummary) => {
    setCreating(false);
    setEditingProviderId(provider.id);
    setEditLabel(provider.label);
    setEditBaseUrl(provider.baseUrl ?? "");
    setEditApiKey("");
    clearEditFeedback();
  };

  const currentEditDraft = (): ProviderEditDraft => ({
    apiKey: editApiKey,
    baseUrl: editBaseUrl,
    label: editLabel,
  });

  const saveProvider = async (provider: ProviderInstanceSummary) => {
    const draft = currentEditDraft();
    const validationError = validateProviderEdit(provider, draft);
    if (validationError) {
      setEditError(validationError);
      setTestMessage(null);
      return;
    }

    setSavingProviderId(provider.id);
    clearEditFeedback();
    try {
      await update.mutateAsync({
        providerId: provider.id,
        request: buildProviderUpdateRequest(provider, draft),
      });
      await update.queryClient.invalidateQueries({
        queryKey: queryKeys.providers,
      });
      closeEdit();
    } catch (error) {
      setEditError(`Could not save provider: ${formatError(error)}`);
    } finally {
      setSavingProviderId(null);
    }
  };

  const testProviderConnection = async (provider: ProviderInstanceSummary) => {
    const draft = currentEditDraft();
    const validationError = validateProviderConnectionTest(provider, draft);
    if (validationError) {
      setEditError(validationError);
      setTestMessage(null);
      return;
    }

    const request = buildProviderTestRequest(provider, draft);
    if (!request) {
      setEditError("Connection status is managed by subscription sign-in.");
      setTestMessage(null);
      return;
    }

    setTestingProviderId(provider.id);
    clearEditFeedback();
    try {
      const result = await testConnection.mutateAsync(request);
      setTestMessage(result.message);
    } catch (error) {
      setEditError(`Connection failed: ${formatError(error)}`);
    } finally {
      setTestingProviderId(null);
    }
  };

  const removeProvider = async (provider: ProviderInstanceSummary) => {
    setRemovingProviderId(provider.id);
    try {
      await remove.mutateAsync(provider.id);
      await remove.queryClient.invalidateQueries({
        queryKey: queryKeys.providers,
      });
      if (editingProviderId === provider.id) {
        closeEdit();
      }
    } catch (error) {
      showMutationError("Could not remove provider", error);
    } finally {
      setRemovingProviderId(null);
    }
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderAddButton
          accessibilityLabel="Add provider"
          disabled={providerMutationPending}
          onPress={() => {
            setApiKey("");
            setCreating((current) => !current);
            closeEdit();
          }}
        />
      ),
    });
  }, [navigation, providerMutationPending]);

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
                          if (provider.id !== providerId) {
                            setApiKey("");
                          }
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
                      providerMutationPending ||
                      (isApiKeyRequired && !apiKey.trim())
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
                (query.data?.providers ?? []).map((provider) => {
                  const subscriptionProvider = isSubscriptionProvider(
                    provider.type
                  );
                  const isEditing = editingProviderId === provider.id;
                  const isSaving = savingProviderId === provider.id;
                  const isTesting = testingProviderId === provider.id;
                  const isRemoving = removingProviderId === provider.id;

                  return (
                    <View key={provider.id}>
                      <ListRow
                        right={
                          <View className="flex-row gap-2">
                            {subscriptionProvider ? null : (
                              <Button
                                disabled={providerMutationPending}
                                onPress={() => openEdit(provider)}
                                size="sm"
                                variant="outline"
                              >
                                <Text>Edit</Text>
                              </Button>
                            )}
                            <Button
                              disabled={providerMutationPending}
                              onPress={() => {
                                confirmDestructive({
                                  confirmLabel: "Remove",
                                  message: provider.label,
                                  onConfirm: () => {
                                    void removeProvider(provider);
                                  },
                                  title: "Remove provider",
                                });
                              }}
                              size="sm"
                              variant="outline"
                            >
                              <Text>{isRemoving ? "Removing…" : "Remove"}</Text>
                            </Button>
                          </View>
                        }
                        subtitle={
                          provider.baseUrl
                            ? `${provider.type} · ${provider.baseUrl}`
                            : provider.type
                        }
                        title={provider.label}
                      />
                      {isEditing && !subscriptionProvider ? (
                        <InlineForm>
                          <Input
                            accessibilityLabel="Provider label"
                            editable={!providerMutationPending}
                            onChangeText={(value) => {
                              setEditLabel(value);
                              clearEditFeedback();
                            }}
                            placeholder="Provider label"
                            value={editLabel}
                          />
                          <Input
                            accessibilityLabel="Base URL"
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!providerMutationPending}
                            keyboardType="url"
                            onChangeText={(value) => {
                              setEditBaseUrl(value);
                              clearEditFeedback();
                            }}
                            placeholder="Base URL (optional)"
                            value={editBaseUrl}
                          />
                          <Input
                            accessibilityLabel="API key"
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!providerMutationPending}
                            onChangeText={(value) => {
                              setEditApiKey(value);
                              clearEditFeedback();
                            }}
                            placeholder={
                              provider.hasApiKey
                                ? "API key (re-enter to replace)"
                                : "API key"
                            }
                            secureTextEntry
                            value={editApiKey}
                          />
                          {editError ? (
                            <Text
                              accessibilityLiveRegion="polite"
                              accessibilityRole="alert"
                              className="text-destructive text-sm"
                            >
                              {editError}
                            </Text>
                          ) : null}
                          {testMessage ? (
                            <Text
                              accessibilityLiveRegion="polite"
                              className="text-muted-foreground text-sm"
                            >
                              {testMessage}
                            </Text>
                          ) : null}
                          <View className="flex-row flex-wrap gap-2">
                            <Button
                              disabled={providerMutationPending}
                              onPress={() => {
                                void saveProvider(provider);
                              }}
                              size="sm"
                            >
                              <Text>
                                {isSaving ? "Saving…" : "Save changes"}
                              </Text>
                            </Button>
                            <Button
                              disabled={providerMutationPending}
                              onPress={() => {
                                void testProviderConnection(provider);
                              }}
                              size="sm"
                              variant="outline"
                            >
                              <Text>
                                {isTesting ? "Testing…" : "Test connection"}
                              </Text>
                            </Button>
                            <Button
                              disabled={providerMutationPending}
                              onPress={closeEdit}
                              size="sm"
                              variant="ghost"
                            >
                              <Text>Cancel</Text>
                            </Button>
                          </View>
                        </InlineForm>
                      ) : null}
                    </View>
                  );
                })
              )}
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
