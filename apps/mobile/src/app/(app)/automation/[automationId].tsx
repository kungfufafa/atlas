import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { SectionHeading } from "@/components/atlas/section-heading";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/features/auth/auth-context";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import {
  useAutomationQuery,
  useAutomationRunsQuery,
} from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { canMutateWorkspace } from "@/lib/roles";

export default function AutomationDetailScreen() {
  const router = useRouter();
  const { automationId: rawId } = useLocalSearchParams<{
    automationId: string;
  }>();
  const automationId = String(rawId);
  const { activeOrg, user } = useAuth();
  const canMutate = canMutateWorkspace({
    activeOrg,
    isPlatformAdmin: user?.isPlatformAdmin,
  });
  const automationQuery = useAutomationQuery(automationId);
  const runsQuery = useAutomationRunsQuery(automationId);
  const run = useAtlasMutation((client) => client.runAutomation(automationId));
  const toggle = useAtlasMutation((client, enabled: boolean) =>
    client.updateAutomation(automationId, { enabled })
  );
  const remove = useAtlasMutation((client) =>
    client.deleteAutomation(automationId)
  );

  const invalidate = async () => {
    await run.queryClient.invalidateQueries({
      queryKey: queryKeys.automation(automationId),
    });
    await run.queryClient.invalidateQueries({
      queryKey: queryKeys.automationRuns(automationId),
    });
    await run.queryClient.invalidateQueries({
      queryKey: queryKeys.automations,
    });
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: automationQuery.data?.name ?? "Automation",
        }}
      />
      <QueryState
        error={automationQuery.error ?? runsQuery.error}
        loading={automationQuery.isLoading || runsQuery.isLoading}
        onRetry={() => {
          void automationQuery.refetch();
          void runsQuery.refetch();
        }}
      >
        <Screen className="px-0">
          <ScrollView>
            <View className="gap-3 px-4 py-3">
              <Text>{automationQuery.data?.prompt}</Text>
              <Text className="text-muted-foreground text-sm">
                {automationQuery.data?.enabled ? "Enabled" : "Paused"}
              </Text>
              {canMutate ? (
                <ActionCluster>
                  <Button
                    disabled={run.isPending}
                    onPress={() => {
                      void run
                        .mutateAsync(undefined)
                        .then(() => invalidate())
                        .catch((error: unknown) => {
                          showMutationError("Could not run automation", error);
                        });
                    }}
                    size="sm"
                  >
                    <Text>{run.isPending ? "Running…" : "Run now"}</Text>
                  </Button>
                  <Button
                    disabled={toggle.isPending}
                    onPress={() => {
                      void toggle
                        .mutateAsync(!(automationQuery.data?.enabled ?? false))
                        .then(() => invalidate())
                        .catch((error: unknown) => {
                          showMutationError(
                            "Could not update automation",
                            error
                          );
                        });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>
                      {toggle.isPending
                        ? "Updating…"
                        : automationQuery.data?.enabled
                          ? "Pause"
                          : "Enable"}
                    </Text>
                  </Button>
                  <Button
                    disabled={remove.isPending}
                    onPress={() => {
                      confirmDestructive({
                        onConfirm: () => {
                          void remove
                            .mutateAsync(undefined)
                            .then(async () => {
                              await invalidate();
                              router.back();
                            })
                            .catch((error: unknown) => {
                              showMutationError(
                                "Could not delete automation",
                                error
                              );
                            });
                        },
                        title: "Delete automation",
                      });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>{remove.isPending ? "Deleting…" : "Delete"}</Text>
                  </Button>
                </ActionCluster>
              ) : null}
            </View>
            <SectionHeading title="Runs" />
            {(runsQuery.data ?? []).map((item) => (
              <ListRow
                key={item.id}
                subtitle={item.error ?? item.output}
                title={`${item.status} · ${item.startedAt}`}
              />
            ))}
          </ScrollView>
        </Screen>
      </QueryState>
    </>
  );
}
