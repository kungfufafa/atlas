import type { TaskStatus, UpdateTaskRequest } from "@atlas/core/contract";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { SectionHeading } from "@/components/atlas/section-heading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/features/auth/auth-context";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useProfilesQuery } from "@/hooks/use-profiles";
import { useTaskQuery, useTaskRunsQuery } from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { canMutateWorkspace } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { buildTaskUpdateRequest } from "@/lib/work-item-edit";

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  done: "Done",
  failed: "Failed",
  in_progress: "In progress",
  todo: "To do",
};

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
  const profilesQuery = useProfilesQuery();
  const [editing, setEditing] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");
  const [draftProfileId, setDraftProfileId] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const run = useAtlasMutation((client) => client.runTask(taskId));
  const remove = useAtlasMutation((client) => client.deleteTask(taskId));
  const update = useAtlasMutation((client, request: UpdateTaskRequest) =>
    client.updateTask(taskId, request)
  );
  const profiles = profilesQuery.data ?? [];
  const assignedProfile = profiles.find(
    (profile) => profile.id === taskQuery.data?.profileId
  );
  const busy = remove.isPending || run.isPending || update.isPending;

  const openEditor = () => {
    const task = taskQuery.data;
    if (!task) {
      return;
    }
    setDraftDescription(task.description);
    setDraftProfileId(task.profileId);
    setDraftPrompt(task.prompt);
    setDraftTitle(task.title);
    setEditing(true);
  };

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
        error={taskQuery.error ?? runsQuery.error ?? profilesQuery.error}
        loading={
          taskQuery.isLoading || runsQuery.isLoading || profilesQuery.isLoading
        }
        onRetry={() => {
          void taskQuery.refetch();
          void runsQuery.refetch();
          void profilesQuery.refetch();
        }}
      >
        <Screen className="px-0">
          <ScrollView>
            <View className="gap-3 px-4 py-3">
              <Text className="text-muted-foreground">
                {taskQuery.data
                  ? TASK_STATUS_LABELS[taskQuery.data.status]
                  : null}
                {assignedProfile ? ` · ${assignedProfile.name}` : ""}
              </Text>
              {taskQuery.data?.description ? (
                <Text>{taskQuery.data.description}</Text>
              ) : null}
              <Text>{taskQuery.data?.prompt}</Text>
              {canMutate ? (
                <ActionCluster>
                  <Button
                    disabled={busy}
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
                    disabled={busy}
                    onPress={() => {
                      if (editing) {
                        setEditing(false);
                        return;
                      }
                      openEditor();
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>{editing ? "Cancel edit" : "Edit"}</Text>
                  </Button>
                  <Button
                    disabled={busy}
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
            {canMutate && editing ? (
              <View className="gap-3 border-border border-y px-4 py-4">
                <View className="gap-2">
                  <Label>Title</Label>
                  <Input
                    accessibilityLabel="Title"
                    editable={!busy}
                    onChangeText={setDraftTitle}
                    value={draftTitle}
                  />
                </View>
                <View className="gap-2">
                  <Label>Description (optional)</Label>
                  <Input
                    accessibilityLabel="Description"
                    editable={!busy}
                    onChangeText={setDraftDescription}
                    value={draftDescription}
                  />
                </View>
                <View className="gap-2">
                  <Label>Agent prompt</Label>
                  <Textarea
                    accessibilityLabel="Agent prompt"
                    className="min-h-32"
                    editable={!busy}
                    onChangeText={setDraftPrompt}
                    value={draftPrompt}
                  />
                </View>
                <Text className="font-heading text-sm">Run as profile</Text>
                <View
                  accessibilityRole="radiogroup"
                  className="flex-row flex-wrap gap-2"
                >
                  {profiles.map((profile) => {
                    const selected = profile.id === draftProfileId;
                    return (
                      <Pressable
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        className={cn(
                          "min-h-11 justify-center rounded-full border border-border px-3",
                          selected && "border-foreground bg-accent"
                        )}
                        disabled={busy}
                        key={profile.id}
                        onPress={() => setDraftProfileId(profile.id)}
                      >
                        <Text className="text-sm">{profile.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Button
                  disabled={
                    busy ||
                    !draftProfileId ||
                    !draftPrompt.trim() ||
                    !draftTitle.trim()
                  }
                  onPress={() => {
                    void update
                      .mutateAsync(
                        buildTaskUpdateRequest({
                          currentProfileId: taskQuery.data?.profileId ?? "",
                          description: draftDescription,
                          profileId: draftProfileId,
                          prompt: draftPrompt,
                          title: draftTitle,
                        })
                      )
                      .then(async () => {
                        setEditing(false);
                        await invalidate();
                      })
                      .catch((error: unknown) => {
                        showMutationError("Could not update task", error);
                      });
                  }}
                >
                  <Text>{update.isPending ? "Saving…" : "Save task"}</Text>
                </Button>
              </View>
            ) : null}
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
