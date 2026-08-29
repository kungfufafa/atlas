import { useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Alert, ScrollView } from "react-native";
import { EmptyState } from "@/components/atlas/empty-state";
import { HeaderAddButton } from "@/components/atlas/header-add-button";
import { InlineForm } from "@/components/atlas/inline-form";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { Segmented } from "@/components/atlas/segmented";
import { RequireWorkspaceMutation } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/features/auth/auth-context";
import { collapseSessionText } from "@/features/chat/sessions";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useProfilesQuery } from "@/hooks/use-profiles";
import { useAutomationsQuery, useTasksQuery } from "@/hooks/use-workspace";
import { queryKeys } from "@/lib/query-keys";
import { canMutateWorkspace } from "@/lib/roles";

type WorkTab = "automations" | "tasks";

export default function WorkScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { activeOrg, user } = useAuth();
  const canMutate = canMutateWorkspace({
    activeOrg,
    isPlatformAdmin: user?.isPlatformAdmin,
  });
  const [tab, setTab] = useState<WorkTab>("tasks");
  const [creating, setCreating] = useState(false);
  const automationsQuery = useAutomationsQuery();
  const tasksQuery = useTasksQuery();
  const profilesQuery = useProfilesQuery();
  const defaultProfile =
    profilesQuery.data?.find((profile) => profile.isDefault) ??
    profilesQuery.data?.[0];
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");

  const createTask = useAtlasMutation(
    (client, input: { prompt: string; title: string }) =>
      client.createTask({
        profileId: defaultProfile?.id,
        prompt: input.prompt,
        title: input.title,
      })
  );
  const createAutomation = useAtlasMutation(
    (client, input: { prompt: string; title: string }) =>
      client.createAutomation({
        description: input.title,
        name: input.title,
        profileId: defaultProfile?.id,
        prompt: input.prompt,
        trigger: { type: "manual" },
      })
  );

  const submit = async () => {
    if (!(title.trim() && prompt.trim())) {
      return;
    }
    try {
      if (tab === "tasks") {
        const task = await createTask.mutateAsync({
          prompt: prompt.trim(),
          title: title.trim(),
        });
        await createTask.queryClient.invalidateQueries({
          queryKey: queryKeys.tasks,
        });
        setTitle("");
        setPrompt("");
        setCreating(false);
        router.push(`/task/${task.id}`);
      } else {
        const automation = await createAutomation.mutateAsync({
          prompt: prompt.trim(),
          title: title.trim(),
        });
        await createAutomation.queryClient.invalidateQueries({
          queryKey: queryKeys.automations,
        });
        setTitle("");
        setPrompt("");
        setCreating(false);
        router.push(`/automation/${automation.id}`);
      }
    } catch (error) {
      Alert.alert(
        "Could not create",
        error instanceof Error ? error.message : ""
      );
    }
  };

  const loading = automationsQuery.isLoading || tasksQuery.isLoading;
  const error = automationsQuery.error ?? tasksQuery.error;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: canMutate
        ? () => (
            <HeaderAddButton
              accessibilityLabel={
                tab === "tasks" ? "New task" : "New automation"
              }
              onPress={() => setCreating((current) => !current)}
            />
          )
        : undefined,
    });
  }, [canMutate, navigation, tab]);

  return (
    <RequireWorkspaceMutation>
      <QueryState
        error={error}
        loading={loading}
        onRetry={() => {
          void automationsQuery.refetch();
          void tasksQuery.refetch();
          void profilesQuery.refetch();
        }}
      >
        <Screen>
          <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
            <Segmented
              onChange={setTab}
              options={[
                { label: "Tasks", value: "tasks" },
                { label: "Automations", value: "automations" },
              ]}
              value={tab}
            />
            {canMutate && creating ? (
              <InlineForm>
                <Input
                  onChangeText={setTitle}
                  placeholder={
                    tab === "tasks" ? "Task title" : "Automation name"
                  }
                  value={title}
                />
                <Input
                  onChangeText={setPrompt}
                  placeholder="Prompt"
                  value={prompt}
                />
                <Button
                  disabled={
                    createTask.isPending ||
                    createAutomation.isPending ||
                    !title.trim() ||
                    !prompt.trim()
                  }
                  onPress={() => {
                    void submit();
                  }}
                >
                  <Text>
                    {tab === "tasks" ? "Create task" : "Create automation"}
                  </Text>
                </Button>
              </InlineForm>
            ) : null}
            {tab === "tasks" ? (
              (tasksQuery.data ?? []).length === 0 ? (
                <EmptyState message="No tasks yet." />
              ) : (
                (tasksQuery.data ?? []).map((task) => (
                  <ListRow
                    key={task.id}
                    onPress={() => router.push(`/task/${task.id}`)}
                    subtitle={`${task.status} · ${collapseSessionText(task.description || task.prompt)}`}
                    title={task.title}
                  />
                ))
              )
            ) : (automationsQuery.data?.automations ?? []).length === 0 ? (
              <EmptyState message="No automations yet." />
            ) : (
              (automationsQuery.data?.automations ?? []).map((automation) => (
                <ListRow
                  key={automation.id}
                  onPress={() => router.push(`/automation/${automation.id}`)}
                  subtitle={
                    automation.enabled
                      ? collapseSessionText(automation.prompt)
                      : `Paused · ${collapseSessionText(automation.prompt)}`
                  }
                  title={automation.name}
                />
              ))
            )}
          </ScrollView>
        </Screen>
      </QueryState>
    </RequireWorkspaceMutation>
  );
}
