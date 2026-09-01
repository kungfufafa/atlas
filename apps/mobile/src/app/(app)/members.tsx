import type {
  AddOrgMemberRequest,
  OrgMemberSummary,
  OrgRole,
} from "@atlas/core/contract";
import * as Clipboard from "expo-clipboard";
import { Stack, useNavigation } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
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
import { useServer } from "@/features/server/server-context";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useMembersQuery } from "@/hooks/use-workspace";
import { confirmDestructive } from "@/lib/confirm";
import { inviteAcceptUrl } from "@/lib/invite";
import { showMutationError } from "@/lib/mutation-error";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

const ROLE_OPTIONS: Array<{ label: string; value: OrgRole }> = [
  { label: "Admin", value: "admin" },
  { label: "Member", value: "member" },
  { label: "Viewer", value: "viewer" },
];

function RolePicker({
  disabled = false,
  onChange,
  value,
}: {
  disabled?: boolean;
  onChange: (role: OrgRole) => void;
  value: OrgRole;
}) {
  return (
    <View accessibilityRole="radiogroup" className="flex-row gap-2">
      {ROLE_OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled }}
            className={cn(
              "min-h-11 flex-1 items-center justify-center rounded-md border border-border px-2",
              selected && "border-foreground bg-accent"
            )}
            disabled={disabled}
            key={option.value}
            onPress={() => onChange(option.value)}
          >
            <Text className="text-sm">{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

type CreateMode = "add" | "invite";

interface MemberSecret {
  label: "Invite link" | "Temporary password";
  value: string;
}

export default function MembersScreen() {
  const navigation = useNavigation();
  const { activeOrg, applyActiveOrgRole, refreshAuth, user } = useAuth();
  const { activeServer } = useServer();
  const orgId = activeOrg?.id;
  const query = useMembersQuery(orgId);
  const [creating, setCreating] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>("invite");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [memberSecret, setMemberSecret] = useState<MemberSecret | null>(null);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<OrgRole>("member");
  const invite = useAtlasMutation(
    (client, input: { email: string; role: OrgRole }) =>
      client.inviteOrgMember(orgId ?? "", input)
  );
  const add = useAtlasMutation((client, request: AddOrgMemberRequest) =>
    client.addOrgMember(orgId ?? "", request)
  );
  const update = useAtlasMutation(
    (client, input: { role: OrgRole; userId: string }) =>
      client.updateOrgMember(orgId ?? "", input.userId, { role: input.role })
  );
  const remove = useAtlasMutation((client, userId: string) =>
    client.removeOrgMember(orgId ?? "", userId)
  );

  const members = query.data?.members ?? [];
  const busy =
    add.isPending || invite.isPending || remove.isPending || update.isPending;

  const invalidateMembers = () =>
    invite.queryClient.invalidateQueries({
      queryKey: queryKeys.members(orgId ?? "none"),
    });

  const resetCreateForm = () => {
    setEmail("");
    setName("");
    setPhone("");
    setRole("member");
    setCreating(false);
  };

  const refreshMembers = async (): Promise<void> => {
    try {
      await invalidateMembers();
    } catch (error) {
      showMutationError("Could not refresh members", error);
    }
  };

  const submitMember = async (): Promise<void> => {
    const nextEmail = email.trim();
    if (!nextEmail) {
      return;
    }

    setMemberSecret(null);
    setCopyHint(null);
    try {
      const result =
        createMode === "invite"
          ? await invite.mutateAsync({ email: nextEmail, role })
          : await add.mutateAsync({
              email: nextEmail,
              name: name.trim(),
              phone: phone.trim() || undefined,
              role,
            });
      resetCreateForm();
      setCopyHint(null);
      if ("token" in result) {
        setMemberSecret({
          label: "Invite link",
          value: activeServer
            ? inviteAcceptUrl(activeServer.url, result.token)
            : result.token,
        });
      } else if (result.temporaryPassword) {
        setMemberSecret({
          label: "Temporary password",
          value: result.temporaryPassword,
        });
      }
      await refreshMembers();
    } catch (error) {
      showMutationError(
        createMode === "invite" ? "Invite failed" : "Could not add member",
        error
      );
    }
  };

  const saveMemberRole = async (member: OrgMemberSummary): Promise<void> => {
    let roleUpdated = false;
    try {
      await update.mutateAsync({
        role: editingRole,
        userId: member.userId,
      });
      roleUpdated = true;
      setEditingMemberId(null);
      if (member.email === user?.email) {
        await applyActiveOrgRole(editingRole);
        await refreshAuth();
        return;
      }
      await invalidateMembers();
    } catch (error) {
      showMutationError(
        roleUpdated
          ? "Role updated, but access could not refresh"
          : "Could not update member",
        error
      );
    }
  };

  const removeMember = async (member: OrgMemberSummary): Promise<void> => {
    let memberRemoved = false;
    try {
      await remove.mutateAsync(member.userId);
      memberRemoved = true;
      if (member.email === user?.email) {
        await applyActiveOrgRole(null);
        await refreshAuth();
        return;
      }
      await invalidateMembers();
    } catch (error) {
      showMutationError(
        memberRemoved
          ? "Member removed, but access could not refresh"
          : "Could not remove member",
        error
      );
    }
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderAddButton
          accessibilityLabel="Add or invite member"
          disabled={busy}
          onPress={() => {
            if (!creating) {
              setMemberSecret(null);
              setCopyHint(null);
            }
            setCreating((current) => !current);
          }}
        />
      ),
    });
  }, [busy, creating, navigation]);

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
                  <RolePicker
                    disabled={busy}
                    onChange={(nextRole) => setRole(nextRole)}
                    value={role}
                  />
                  <View className="flex-row gap-2">
                    <Button
                      className="flex-1"
                      disabled={busy}
                      onPress={() => setCreateMode("invite")}
                      variant={createMode === "invite" ? "default" : "outline"}
                    >
                      <Text>Invite</Text>
                    </Button>
                    <Button
                      className="flex-1"
                      disabled={busy}
                      onPress={() => setCreateMode("add")}
                      variant={createMode === "add" ? "default" : "outline"}
                    >
                      <Text>Add directly</Text>
                    </Button>
                  </View>
                  {createMode === "add" ? (
                    <Input
                      autoCapitalize="words"
                      onChangeText={setName}
                      placeholder="Name"
                      value={name}
                    />
                  ) : null}
                  <Input
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    onChangeText={setEmail}
                    placeholder="Invite email"
                    value={email}
                  />
                  {createMode === "add" ? (
                    <Input
                      keyboardType="phone-pad"
                      onChangeText={setPhone}
                      placeholder="Phone (optional)"
                      value={phone}
                    />
                  ) : null}
                  <Button
                    disabled={
                      busy ||
                      !email.trim() ||
                      (createMode === "add" && !name.trim())
                    }
                    onPress={() => {
                      void submitMember();
                    }}
                  >
                    <Text>
                      {busy
                        ? createMode === "invite"
                          ? "Inviting…"
                          : "Adding…"
                        : createMode === "invite"
                          ? "Send invite"
                          : "Add member"}
                    </Text>
                  </Button>
                </InlineForm>
              ) : null}
              {memberSecret ? (
                <View className="gap-3 border-border border-b px-4 py-4">
                  <Text className="font-heading text-sm">
                    {memberSecret.label}
                  </Text>
                  <View className="rounded-lg border border-border bg-muted/35 p-3">
                    <Text className="font-mono text-xs" selectable>
                      {memberSecret.value}
                    </Text>
                  </View>
                  {copyHint ? (
                    <Text className="text-muted-foreground text-sm">
                      {copyHint}
                    </Text>
                  ) : null}
                  <ActionCluster>
                    <Button
                      onPress={() => {
                        void Clipboard.setStringAsync(memberSecret.value)
                          .then(() => setCopyHint("Copied."))
                          .catch((error: unknown) => {
                            showMutationError("Could not copy", error);
                          });
                      }}
                      size="sm"
                    >
                      <Text>Copy</Text>
                    </Button>
                    <Button
                      onPress={() => {
                        setMemberSecret(null);
                        setCopyHint(null);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Text>Dismiss</Text>
                    </Button>
                  </ActionCluster>
                </View>
              ) : null}
              {members.length === 0 ? (
                <EmptyState message="No members." />
              ) : (
                members.map((member) => {
                  const editing = editingMemberId === member.userId;
                  return (
                    <View key={member.userId}>
                      <ListRow
                        right={
                          <ActionCluster>
                            <Button
                              disabled={busy}
                              onPress={() => {
                                setEditingMemberId(
                                  editing ? null : member.userId
                                );
                                setEditingRole(member.role);
                              }}
                              size="sm"
                              variant="outline"
                            >
                              <Text>{editing ? "Cancel" : "Edit"}</Text>
                            </Button>
                            <Button
                              disabled={busy}
                              onPress={() => {
                                confirmDestructive({
                                  confirmLabel: "Remove",
                                  message: member.email,
                                  onConfirm: () => {
                                    void removeMember(member);
                                  },
                                  title: "Remove member",
                                });
                              }}
                              size="sm"
                              variant="outline"
                            >
                              <Text>
                                {remove.isPending ? "Removing…" : "Remove"}
                              </Text>
                            </Button>
                          </ActionCluster>
                        }
                        subtitle={member.email}
                        title={member.name || member.email}
                        value={member.role}
                      />
                      {editing ? (
                        <View className="gap-2 border-border border-b px-4 pb-4">
                          <RolePicker
                            disabled={busy}
                            onChange={setEditingRole}
                            value={editingRole}
                          />
                          <Button
                            disabled={busy || editingRole === member.role}
                            onPress={() => {
                              void saveMemberRole(member);
                            }}
                          >
                            <Text>
                              {update.isPending ? "Saving…" : "Save role"}
                            </Text>
                          </Button>
                        </View>
                      ) : null}
                    </View>
                  );
                })
              )}
            </ScrollView>
          </Screen>
        </QueryState>
      </RequireWorkspaceAdmin>
    </>
  );
}
