import { useNavigation, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
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
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/features/auth/auth-context";
import { collapseSessionText } from "@/features/chat/sessions";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useProfilesQuery } from "@/hooks/use-profiles";
import { useAutomationsQuery, useTasksQuery } from "@/hooks/use-workspace";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { canMutateWorkspace } from "@/lib/roles";
import { cn } from "@/lib/utils";

type WorkTab = "automations" | "tasks";

export default function WorkScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { activeOrg, user } = useAuth();
  const canMutate = canMutateWorkspace({
    activeOrg,
    isPlatformAdmin: user?.isPlatformAdmin,
  });
  const [tab, setTab] = useState<WorkTab>("automations");
  const [creating, setCreating] = useState(false);
  const automationsQuery = useAutomationsQuery();
  const tasksQuery = useTasksQuery();
  const profilesQuery = useProfilesQuery();
  const defaultProfile =
    profilesQuery.data?.find((profile) => profile.isDefault) ??
    profilesQuery.data?.[0];
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [profileId, setProfileId] = useState("");

  useEffect(() => {
    const profiles = profilesQuery.data ?? [];
    if (profiles.some((profile) => profile.id === profileId)) {
      return;
    }
    setProfileId(defaultProfile?.id ?? "");
  }, [defaultProfile?.id, profileId, profilesQuery.data]);

  const createTask = useAtlasMutation(
    (
      client,
      input: {
        description: string;
        profileId: string;
        prompt: string;
        title: string;
      }
    ) =>
      client.createTask({
        description: input.description || undefined,
        profileId: input.profileId,
        prompt: input.prompt,
        title: input.title,
      })
  );
  const createAutomation = useAtlasMutation(
    (
      client,
      input: {
        description: string;
        profileId: string;
        prompt: string;
        title: string;
      }
    ) =>
      client.createAutomation({
        description: input.description,
        name: input.title,
        profileId: input.profileId,
        prompt: input.prompt,
        trigger: { type: "manual" },
      })
  );

  const submit = async () => {
    if (!(title.trim() && prompt.trim() && profileId)) {
      return;
    }
    const input = {
      description: description.trim(),
      profileId,
      prompt: prompt.trim(),
      title: title.trim(),
    };
    try {
      if (tab === "tasks") {
        const task = await createTask.mutateAsync(input);
        await createTask.queryClient.invalidateQueries({
          queryKey: queryKeys.tasks,
        });
        setTitle("");
        setDescription("");
        setPrompt("");
        setCreating(false);
        router.push(`/task/${task.id}`);
      } else {
        const automation = await createAutomation.mutateAsync(input);
        await createAutomation.queryClient.invalidateQueries({
          queryKey: queryKeys.automations,
        });
        setTitle("");
        setDescription("");
        setPrompt("");
        setCreating(false);
        router.push(`/automation/${automation.id}`);
      }
    } catch (error) {
      showMutationError("Could not create", error);
    }
  };

  const loading =
    automationsQuery.isLoading ||
    tasksQuery.isLoading ||
    profilesQuery.isLoading;
  const error =
    automationsQuery.error ?? tasksQuery.error ?? profilesQuery.error;
  const isCreatePending = createTask.isPending || createAutomation.isPending;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: canMutate
        ? () => (
            <HeaderAddButton
              accessibilityLabel={
                tab === "tasks" ? "New task" : "New automation"
              }
              disabled={isCreatePending}
              onPress={() => setCreating((current) => !current)}
            />
          )
        : undefined,
    });
  }, [canMutate, isCreatePending, navigation, tab]);

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
                { label: "Automations", value: "automations" },
                { label: "Tasks", value: "tasks" },
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
                  onChangeText={setDescription}
                  placeholder="Description (optional)"
                  value={description}
                />
                <Textarea
                  className="min-h-28"
                  onChangeText={setPrompt}
                  placeholder={tab === "tasks" ? "Agent prompt" : "Prompt"}
                  value={prompt}
                />
                <Text className="font-heading text-sm">Run as profile</Text>
                <View
                  accessibilityRole="radiogroup"
                  className="flex-row flex-wrap gap-2"
                >
                  {(profilesQuery.data ?? []).map((profile) => {
                    const selected = profile.id === profileId;
                    return (
                      <Pressable
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        className={cn(
                          "min-h-11 justify-center rounded-full border border-border px-3",
                          selected && "border-foreground bg-accent"
                        )}
                        disabled={isCreatePending}
                        key={profile.id}
                        onPress={() => setProfileId(profile.id)}
                      >
                        <Text className="text-sm">{profile.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Button
                  disabled={
                    isCreatePending ||
                    !profileId ||
                    !title.trim() ||
                    !prompt.trim()
                  }
                  onPress={() => {
                    void submit();
                  }}
                >
                  <Text>
                    {isCreatePending
                      ? "Creating…"
                      : tab === "tasks"
                        ? "Create task"
                        : "Create automation"}
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
