import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useSkillQuery } from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";

export default function SkillDetailScreen() {
  const router = useRouter();
  const { skillId: rawId } = useLocalSearchParams<{ skillId: string }>();
  const skillId = String(rawId);
  const query = useSkillQuery(skillId);
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const save = useAtlasMutation(
    (client, input: { body: string; description: string }) =>
      client.patchSkill(skillId, input)
  );
  const descriptionTrimmed = description.trim();
  const bodyTrimmed = body.trim();
  const canSave = !save.isPending && Boolean(descriptionTrimmed && bodyTrimmed);
  const remove = useAtlasMutation((client) => client.deleteSkill(skillId));

  useEffect(() => {
    if (!query.data) {
      return;
    }
    setDescription(query.data.description);
    setBody(query.data.body);
  }, [query.data]);

  return (
    <>
      <Stack.Screen
        options={{ headerShown: true, title: query.data?.name ?? "Skill" }}
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
                <Input onChangeText={setDescription} value={description} />
                <Textarea
                  className="min-h-40"
                  onChangeText={setBody}
                  value={body}
                />
                <ActionCluster>
                  <Button
                    disabled={!canSave}
                    onPress={() => {
                      void save
                        .mutateAsync({
                          body: bodyTrimmed,
                          description: descriptionTrimmed,
                        })
                        .then(() =>
                          save.queryClient.invalidateQueries({
                            queryKey: queryKeys.skill(skillId),
                          })
                        )
                        .catch((error: unknown) => {
                          showMutationError("Could not save skill", error);
                        });
                    }}
                    size="sm"
                  >
                    <Text>Save</Text>
                  </Button>
                  <Button
                    onPress={() => {
                      confirmDestructive({
                        message: query.data?.name,
                        onConfirm: () => {
                          void remove
                            .mutateAsync(undefined)
                            .then(async () => {
                              await remove.queryClient.invalidateQueries({
                                queryKey: queryKeys.skills,
                              });
                              router.back();
                            })
                            .catch((error: unknown) => {
                              showMutationError(
                                "Could not delete skill",
                                error
                              );
                            });
                        },
                        title: "Delete skill",
                      });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Text>{remove.isPending ? "Deleting…" : "Delete"}</Text>
                  </Button>
                </ActionCluster>
              </View>
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
