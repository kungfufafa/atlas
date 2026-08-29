import { Stack, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { EmptyState } from "@/components/atlas/empty-state";
import { ListRow } from "@/components/atlas/list-row";
import { QueryState } from "@/components/atlas/query-state";
import { Screen } from "@/components/atlas/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/features/auth/auth-context";
import { buildInboxItems } from "@/features/inbox/inbox-items";
import { useAtlasMutation, useAtlasQuery } from "@/hooks/use-atlas-query";
import {
  useOrgMemoryProposalsQuery,
  useSkillProposalsQuery,
} from "@/hooks/use-workspace";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";

export default function NotificationsScreen() {
  const router = useRouter();
  const { activeOrg } = useAuth();
  const { isAdmin } = useWorkspaceAccess();
  const orgId = activeOrg?.id;
  const automationsQuery = useAtlasQuery(
    queryKeys.automations,
    (client) => client.listAutomations(),
    { refetchInterval: 30_000 }
  );
  const memoryQuery = useOrgMemoryProposalsQuery(orgId, isAdmin);
  const skillsQuery = useSkillProposalsQuery(orgId, isAdmin);
  const markRead = useAtlasMutation((client, automationId: string) =>
    client.markAutomationRunsRead(automationId)
  );
  const approveMemory = useAtlasMutation((client, proposalId: string) =>
    client.approveOrgMemoryProposal(orgId ?? "", proposalId)
  );
  const rejectMemory = useAtlasMutation((client, proposalId: string) =>
    client.rejectOrgMemoryProposal(orgId ?? "", proposalId)
  );
  const approveSkill = useAtlasMutation((client, proposalId: string) =>
    client.approveSkillProposal(orgId ?? "", proposalId)
  );
  const rejectSkill = useAtlasMutation((client, proposalId: string) =>
    client.rejectSkillProposal(orgId ?? "", proposalId)
  );

  const items = buildInboxItems({
    automations: automationsQuery.data?.automations ?? [],
    memoryProposals: memoryQuery.data?.proposals,
    skillProposals: skillsQuery.data?.proposals,
    unreadByAutomationId: automationsQuery.data?.unread?.byAutomationId,
  });

  const invalidateInbox = async () => {
    await automationsQuery.refetch();
    await memoryQuery.refetch();
    await skillsQuery.refetch();
  };

  const loading =
    automationsQuery.isLoading ||
    (isAdmin && (memoryQuery.isLoading || skillsQuery.isLoading));
  const error =
    automationsQuery.error ?? memoryQuery.error ?? skillsQuery.error;
  const isProposalActionPending =
    approveMemory.isPending ||
    approveSkill.isPending ||
    rejectMemory.isPending ||
    rejectSkill.isPending;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Notifications" }} />
      <QueryState
        error={error}
        loading={loading}
        onRetry={() => {
          void invalidateInbox();
        }}
      >
        <Screen className="px-0">
          <ScrollView>
            {items.length === 0 ? (
              <EmptyState message="All caught up." />
            ) : (
              items.map((item) => (
                <View key={item.id}>
                  <ListRow
                    onPress={
                      item.kind === "automation-run" &&
                      item.automationId &&
                      !markRead.isPending
                        ? () => {
                            const automationId = item.automationId;
                            if (!automationId) {
                              return;
                            }
                            void markRead
                              .mutateAsync(automationId)
                              .catch((error: unknown) => {
                                showMutationError(
                                  "Could not mark as read",
                                  error
                                );
                              })
                              .finally(() => {
                                router.push(`/automation/${automationId}`);
                              });
                          }
                        : item.kind === "skill-proposal" && item.profileId
                          ? () => router.push(`/profile/${item.profileId}`)
                          : item.kind === "org-memory-proposal"
                            ? () => router.push("/system")
                            : undefined
                    }
                    subtitle={`${item.kindLabel} · ${item.description}`}
                    title={
                      item.count > 1
                        ? `${item.title} (${item.count})`
                        : item.title
                    }
                  />
                  {isAdmin && item.proposalId ? (
                    <View className="flex-row gap-2 border-border border-b px-4 pb-3">
                      <Button
                        className="flex-1"
                        disabled={
                          isProposalActionPending ||
                          (item.kind === "skill-proposal"
                            ? approveSkill.isPending
                            : approveMemory.isPending)
                        }
                        onPress={() => {
                          const run =
                            item.kind === "skill-proposal"
                              ? approveSkill.mutateAsync(item.proposalId ?? "")
                              : approveMemory.mutateAsync(
                                  item.proposalId ?? ""
                                );
                          void run
                            .then(invalidateInbox)
                            .catch((caught: unknown) => {
                              showMutationError("Could not approve", caught);
                            });
                        }}
                        size="sm"
                      >
                        <Text>
                          {item.kind === "skill-proposal" &&
                          approveSkill.isPending
                            ? "Approving…"
                            : item.kind === "org-memory-proposal" &&
                                approveMemory.isPending
                              ? "Approving…"
                              : "Approve"}
                        </Text>
                      </Button>
                      <Button
                        className="flex-1"
                        disabled={
                          isProposalActionPending ||
                          (item.kind === "skill-proposal"
                            ? rejectSkill.isPending
                            : rejectMemory.isPending)
                        }
                        onPress={() => {
                          const run =
                            item.kind === "skill-proposal"
                              ? rejectSkill.mutateAsync(item.proposalId ?? "")
                              : rejectMemory.mutateAsync(item.proposalId ?? "");
                          void run
                            .then(invalidateInbox)
                            .catch((caught: unknown) => {
                              showMutationError("Could not reject", caught);
                            });
                        }}
                        size="sm"
                        variant="outline"
                      >
                        <Text>
                          {item.kind === "skill-proposal" &&
                          rejectSkill.isPending
                            ? "Rejecting…"
                            : item.kind === "org-memory-proposal" &&
                                rejectMemory.isPending
                              ? "Rejecting…"
                              : "Reject"}
                        </Text>
                      </Button>
                    </View>
                  ) : null}
                </View>
              ))
            )}
          </ScrollView>
        </Screen>
      </QueryState>
    </>
  );
}
