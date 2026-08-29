import type { CreateMcpServerRequest } from "@atlas/core/contract";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Alert, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { SectionHeading } from "@/components/atlas/section-heading";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useMcpServerQuery } from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";

export default function McpDetailScreen() {
  const router = useRouter();
  const { serverId: rawId } = useLocalSearchParams<{ serverId: string }>();
  const serverId = String(rawId);
  const query = useMcpServerQuery(serverId);
  const connect = useAtlasMutation((client) =>
    client.connectMcpServer(serverId)
  );
  const sync = useAtlasMutation((client) => client.syncMcpServer(serverId));
  const test = useAtlasMutation((client, request: CreateMcpServerRequest) =>
    client.testMcpServer(request)
  );
  const remove = useAtlasMutation((client) => client.deleteMcpServer(serverId));

  const invalidate = async () => {
    await connect.queryClient.invalidateQueries({
      queryKey: queryKeys.mcpServer(serverId),
    });
    await connect.queryClient.invalidateQueries({ queryKey: queryKeys.mcp });
  };

  const server = query.data;

  return (
    <>
      <Stack.Screen
        options={{ headerShown: true, title: server?.name ?? "MCP" }}
      />
      <RequireWorkspaceAdmin>
        <QueryState
          error={query.error}
          loading={query.isLoading}
          onRetry={() => {
            void query.refetch();
          }}
        >
          <Screen className="px-0">
            <ScrollView>
              <View className="gap-3 px-4 py-3">
                <Text className="text-muted-foreground">
                  {server?.transport} · {server?.status}
                </Text>
                <ActionCluster>
                  <Button
                    onPress={() => {
                      void connect
                        .mutateAsync(undefined)
                        .then(() => invalidate())
                        .catch((error: unknown) => {
                          showMutationError("Connect failed", error);
                        });
                    }}
                    size="sm"
                  >
                    <Text>Connect</Text>
                  </Button>
                  <Button
                    onPress={() => {
                      void sync
                        .mutateAsync(undefined)
                        .then(() => invalidate())
                        .catch((error: unknown) => {
                          showMutationError("Sync failed", error);
                        });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>Sync</Text>
                  </Button>
                  <Button
                    onPress={() => {
                      if (!server) {
                        return;
                      }
                      void test
                        .mutateAsync({
                          config: server.config,
                          name: server.name,
                          serverId,
                          transport: server.transport,
                        })
                        .then((response) => {
                          Alert.alert(
                            response.ok ? "MCP ok" : "MCP failed",
                            response.error ?? `${response.toolCount} tools`
                          );
                        })
                        .catch((error: unknown) => {
                          showMutationError("Test failed", error);
                        });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>Test</Text>
                  </Button>
                  <Button
                    onPress={() => {
                      confirmDestructive({
                        message: server?.name,
                        onConfirm: () => {
                          void remove
                            .mutateAsync(undefined)
                            .then(async () => {
                              await invalidate();
                              router.back();
                            })
                            .catch((error: unknown) => {
                              showMutationError(
                                "Could not delete MCP server",
                                error
                              );
                            });
                        },
                        title: "Delete MCP server",
                      });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>Delete</Text>
                  </Button>
                </ActionCluster>
              </View>
              <SectionHeading title="Tools" />
              {(server?.cachedTools ?? []).map((tool) => (
                <ListRow
                  key={tool.name}
                  subtitle={tool.description}
                  title={tool.name}
                />
              ))}
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
