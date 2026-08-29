import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useToolQuery } from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import {
  buildExampleParametersJson,
  parseParametersJson,
} from "@/lib/playground-params";
import { queryKeys } from "@/lib/query-keys";

export default function ToolPlaygroundScreen() {
  const router = useRouter();
  const { toolId: rawId } = useLocalSearchParams<{ toolId: string }>();
  const toolId = String(rawId);
  const query = useToolQuery(toolId);
  const [parametersJson, setParametersJson] = useState("{}");
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState<string | null>(null);
  const run = useAtlasMutation((client, parameters: Record<string, unknown>) =>
    client.runTool(toolId, { parameters })
  );
  const suggest = useAtlasMutation((client, nextPrompt: string) =>
    client.suggestToolParams(toolId, { prompt: nextPrompt })
  );
  const remove = useAtlasMutation((client) => client.deleteTool(toolId));

  useEffect(() => {
    if (query.data?.parameters) {
      setParametersJson(buildExampleParametersJson(query.data.parameters));
    }
  }, [query.data?.parameters]);

  return (
    <>
      <Stack.Screen
        options={{ headerShown: true, title: query.data?.name ?? "Tool" }}
      />
      <RequireWorkspaceAdmin>
        <QueryState
          error={query.error}
          loading={query.isLoading}
          onRetry={() => {
            void query.refetch();
          }}
        >
          <Screen padded>
            <ScrollView keyboardShouldPersistTaps="handled">
              <View className="gap-3 pb-8">
                <Text className="text-muted-foreground">
                  {query.data?.description}
                </Text>
                <Textarea
                  className="min-h-32 font-mono"
                  onChangeText={setParametersJson}
                  value={parametersJson}
                />
                <Textarea
                  onChangeText={setPrompt}
                  placeholder="Suggest params"
                  value={prompt}
                />
                <ActionCluster>
                  <Button
                    disabled={run.isPending}
                    onPress={() => {
                      const parsed = parseParametersJson(parametersJson);
                      if (!parsed) {
                        Alert.alert("Invalid JSON object");
                        return;
                      }
                      void run
                        .mutateAsync(parsed)
                        .then((response) => {
                          setOutput(
                            response.error ??
                              JSON.stringify(response.result, null, 2)
                          );
                        })
                        .catch((error: unknown) => {
                          showMutationError("Run failed", error);
                        });
                    }}
                    size="sm"
                  >
                    <Text>{run.isPending ? "Running…" : "Run"}</Text>
                  </Button>
                  <Button
                    disabled={suggest.isPending || prompt.trim().length === 0}
                    onPress={() => {
                      void suggest
                        .mutateAsync(prompt.trim())
                        .then((response) => {
                          setParametersJson(
                            JSON.stringify(response.parameters, null, 2)
                          );
                        })
                        .catch((error: unknown) => {
                          showMutationError("Suggest failed", error);
                        });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>{suggest.isPending ? "Suggesting…" : "Suggest"}</Text>
                  </Button>
                  {query.data?.handlerType === "javascript" ? (
                    <Button
                      disabled={remove.isPending}
                      onPress={() => {
                        confirmDestructive({
                          message: query.data?.name,
                          onConfirm: () => {
                            void remove
                              .mutateAsync(undefined)
                              .then(async () => {
                                await remove.queryClient.invalidateQueries({
                                  queryKey: queryKeys.tools,
                                });
                                router.back();
                              })
                              .catch((error: unknown) => {
                                showMutationError(
                                  "Could not delete tool",
                                  error
                                );
                              });
                          },
                          title: "Delete tool",
                        });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>{remove.isPending ? "Deleting…" : "Delete"}</Text>
                    </Button>
                  ) : null}
                </ActionCluster>
                {output ? (
                  <Text className="font-mono text-xs" selectable>
                    {output}
                  </Text>
                ) : null}
              </View>
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
