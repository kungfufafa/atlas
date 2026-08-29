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
import { useTaskQuery, useTaskRunsQuery } from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { canMutateWorkspace } from "@/lib/roles";

export default function TaskDetailScreen() {
  const router = useRouter();
  const { taskId: rawId } = useLocalSearchParams<{ taskId: string }>();
  const taskId = String(rawId);
  const { activeOrg, user } = useAuth();
  const canMutate = canMutateWorkspace({
    activeOrg,
    isPlatformAdmin: user?.isPlatformAdmin,
  });
  const taskQuery = useTaskQuery(taskId);
  const runsQuery = useTaskRunsQuery(taskId);
  const run = useAtlasMutation((client) => client.runTask(taskId));
  const remove = useAtlasMutation((client) => client.deleteTask(taskId));

  const invalidate = async () => {
    await run.queryClient.invalidateQueries({
      queryKey: queryKeys.task(taskId),
    });
    await run.queryClient.invalidateQueries({
      queryKey: queryKeys.taskRuns(taskId),
    });
    await run.queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
  };

  return (
    <>
      <Stack.Screen
        options={{ headerShown: true, title: taskQuery.data?.title ?? "Task" }}
      />
      <QueryState
        error={taskQuery.error ?? runsQuery.error}
        loading={taskQuery.isLoading || runsQuery.isLoading}
        onRetry={() => {
          void taskQuery.refetch();
          void runsQuery.refetch();
        }}
      >
        <Screen className="px-0">
          <ScrollView>
            <View className="gap-3 px-4 py-3">
              <Text className="text-muted-foreground">
                {taskQuery.data?.status}
              </Text>
              <Text>{taskQuery.data?.prompt}</Text>
              {canMutate ? (
                <ActionCluster>
                  <Button
                    disabled={run.isPending}
                    onPress={() => {
                      void run
                        .mutateAsync(undefined)
                        .then(() => invalidate())
                        .catch((error: unknown) => {
                          showMutationError("Could not run task", error);
                        });
                    }}
                    size="sm"
                  >
                    <Text>{run.isPending ? "Running…" : "Run"}</Text>
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
                              showMutationError("Could not delete task", error);
                            });
                        },
                        title: "Delete task",
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
