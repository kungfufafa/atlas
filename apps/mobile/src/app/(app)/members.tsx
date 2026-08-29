import { Stack, useNavigation } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { ScrollView } from "react-native";
import { EmptyState } from "@/components/atlas/empty-state";
import { HeaderAddButton } from "@/components/atlas/header-add-button";
import { InlineForm } from "@/components/atlas/inline-form";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { RequireWorkspaceAdmin } from "@/components/atlas/workspace-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/features/auth/auth-context";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useMembersQuery } from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";

export default function MembersScreen() {
  const navigation = useNavigation();
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.id;
  const query = useMembersQuery(orgId);
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState("");
  const invite = useAtlasMutation((client, nextEmail: string) =>
    client.inviteOrgMember(orgId ?? "", { email: nextEmail, role: "member" })
  );
  const remove = useAtlasMutation((client, userId: string) =>
    client.removeOrgMember(orgId ?? "", userId)
  );

  const members = query.data?.members ?? [];

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderAddButton
          accessibilityLabel="Invite member"
          onPress={() => setCreating((current) => !current)}
        />
      ),
    });
  }, [navigation]);

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Members" }} />
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
              {creating ? (
                <InlineForm>
                  <Input
                    autoCapitalize="none"
                    keyboardType="email-address"
                    onChangeText={setEmail}
                    placeholder="Invite email"
                    value={email}
                  />
                  <Button
                    onPress={() => {
                      void invite
                        .mutateAsync(email.trim())
                        .then(async () => {
                          setEmail("");
                          setCreating(false);
                          await invite.queryClient.invalidateQueries({
                            queryKey: queryKeys.members(orgId ?? "none"),
                          });
                        })
                        .catch((error: unknown) => {
                          showMutationError("Invite failed", error);
                        });
                    }}
                  >
                    <Text>Send invite</Text>
                  </Button>
                </InlineForm>
              ) : null}
              {members.length === 0 ? (
                <EmptyState message="No members." />
              ) : (
                members.map((member) => (
                  <ListRow
                    key={member.userId}
                    right={
                      <Button
                        onPress={() => {
                          confirmDestructive({
                            confirmLabel: "Remove",
                            message: member.email,
                            onConfirm: () => {
                              void remove
                                .mutateAsync(member.userId)
                                .then(() =>
                                  remove.queryClient.invalidateQueries({
                                    queryKey: queryKeys.members(
                                      orgId ?? "none"
                                    ),
                                  })
                                )
                                .catch((error: unknown) => {
                                  showMutationError(
                                    "Could not remove member",
                                    error
                                  );
                                });
                            },
                            title: "Remove member",
                          });
                        }}
                        size="sm"
                        variant="outline"
                      >
                        <Text>Remove</Text>
                      </Button>
                    }
                    subtitle={member.role}
                    title={member.name || member.email}
                  />
                ))
              )}
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
