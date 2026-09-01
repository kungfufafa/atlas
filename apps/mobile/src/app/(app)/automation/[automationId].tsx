import type { UpdateAutomationRequest } from "@atlas/core/contract";
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
import {
  useAutomationQuery,
  useAutomationRunsQuery,
} from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { canMutateWorkspace } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { buildAutomationUpdateRequest } from "@/lib/work-item-edit";

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
  const profilesQuery = useProfilesQuery();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftProfileId, setDraftProfileId] = useState("");
  const run = useAtlasMutation((client) => client.runAutomation(automationId));
  const toggle = useAtlasMutation((client, enabled: boolean) =>
    client.updateAutomation(automationId, { enabled })
  );
  const remove = useAtlasMutation((client) =>
    client.deleteAutomation(automationId)
  );
  const update = useAtlasMutation((client, request: UpdateAutomationRequest) =>
    client.updateAutomation(automationId, request)
  );

  const profiles = profilesQuery.data ?? [];
  const runAsProfile = profiles.find(
    (profile) => profile.id === automationQuery.data?.profileId
  );
  const busy =
    remove.isPending || run.isPending || toggle.isPending || update.isPending;

  const openEditor = () => {
    const automation = automationQuery.data;
    if (!automation) {
      return;
    }
    setDraftDescription(automation.description);
    setDraftName(automation.name);
    setDraftProfileId(automation.profileId);
    setDraftPrompt(automation.prompt);
    setEditing(true);
  };

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
        error={automationQuery.error ?? runsQuery.error ?? profilesQuery.error}
        loading={
          automationQuery.isLoading ||
          runsQuery.isLoading ||
          profilesQuery.isLoading
        }
        onRetry={() => {
          void automationQuery.refetch();
          void runsQuery.refetch();
          void profilesQuery.refetch();
        }}
      >
        <Screen className="px-0">
          <ScrollView>
            <View className="gap-3 px-4 py-3">
              <Text>{automationQuery.data?.prompt}</Text>
              <Text className="text-muted-foreground text-sm">
                {automationQuery.data?.enabled ? "Enabled" : "Paused"}
                {runAsProfile ? ` · Runs as ${runAsProfile.name}` : ""}
              </Text>
              {canMutate ? (
                <ActionCluster>
                  <Button
                    disabled={busy || !automationQuery.data?.enabled}
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
                    disabled={busy}
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
            {canMutate && editing ? (
              <View className="gap-3 border-border border-y px-4 py-4">
                <View className="gap-2">
                  <Label>Name</Label>
                  <Input
                    accessibilityLabel="Name"
                    editable={!busy}
                    onChangeText={setDraftName}
                    value={draftName}
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
                  <Label>Prompt</Label>
                  <Textarea
                    accessibilityLabel="Prompt"
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
                    !draftName.trim() ||
                    !draftPrompt.trim() ||
                    !draftProfileId
                  }
                  onPress={() => {
                    void update
                      .mutateAsync(
                        buildAutomationUpdateRequest({
                          currentProfileId:
                            automationQuery.data?.profileId ?? "",
                          description: draftDescription,
                          name: draftName,
                          profileId: draftProfileId,
                          prompt: draftPrompt,
                        })
                      )
                      .then(async () => {
                        setEditing(false);
                        await invalidate();
                      })
                      .catch((error: unknown) => {
                        showMutationError("Could not update automation", error);
                      });
                  }}
                >
                  <Text>
                    {update.isPending ? "Saving…" : "Save automation"}
                  </Text>
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
