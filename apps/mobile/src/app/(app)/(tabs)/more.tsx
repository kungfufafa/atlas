import { useRouter } from "expo-router";
import { ListRow } from "@/components/atlas/list-row";
import { Screen } from "@/components/atlas/screen";
import { useAuth } from "@/features/auth/auth-context";
import { useWorkspaceAccess } from "@/hooks/use-workspace-access";

export default function MoreScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { canAccessIntegrations, isAdmin } = useWorkspaceAccess();

  return (
    <Screen>
      <ListRow
        onPress={() => router.push("/account")}
        subtitle={user?.email}
        title="Account"
      />
      <ListRow
        onPress={() => router.push("/notifications")}
        title="Notifications"
      />
      {canAccessIntegrations ? (
        <ListRow
          onPress={() => router.push("/integrations")}
          title="Integrations"
        />
      ) : null}
      {isAdmin ? (
        <>
          <ListRow
            onPress={() => router.push("/providers")}
            title="Providers"
          />
          <ListRow onPress={() => router.push("/members")} title="Members" />
          <ListRow onPress={() => router.push("/system")} title="System" />
        </>
      ) : null}
    </Screen>
  );
}
