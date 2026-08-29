import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { Screen } from "@/components/atlas/screen";
import { ServerSwitcher } from "@/components/atlas/server-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/features/auth/auth-context";
import { useAppTheme } from "@/features/theme/theme-provider";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useTimezoneQuery } from "@/hooks/use-workspace";
import { showMutationError } from "@/lib/mutation-error";
import type { ThemePreference } from "@/lib/storage";

const THEME_OPTIONS: ThemePreference[] = ["system", "light", "dark"];

export default function AccountScreen() {
  const router = useRouter();
  const { activeOrg, applyUser, logout, orgs, switchOrg, user } = useAuth();
  const { preference, setPreference } = useAppTheme();
  const timezoneQuery = useTimezoneQuery();
  const [name, setName] = useState(user?.name ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [timezone, setTimezone] = useState("");

  const saveProfile = useAtlasMutation((client, nextName: string) =>
    client.updateAuthProfile({ name: nextName })
  );
  const savePassword = useAtlasMutation(
    (client, input: { currentPassword: string; newPassword: string }) =>
      client.changePassword(input)
  );
  const saveTimezone = useAtlasMutation((client, next: string) =>
    client.setTimezone(next)
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Account" }} />
      <Screen padded>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-6 pb-8">
            <View className="gap-2">
              <Text className="font-heading">{user?.email}</Text>
              <Label>Name</Label>
              <Input onChangeText={setName} value={name} />
              <ActionCluster>
                <Button
                  onPress={() => {
                    void saveProfile
                      .mutateAsync(name.trim())
                      .then((response) => {
                        applyUser(response);
                      })
                      .catch((error: unknown) => {
                        showMutationError("Could not save", error);
                      });
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Text>Save name</Text>
                </Button>
              </ActionCluster>
            </View>

            {orgs.length > 1 ? (
              <View>
                <Text className="mb-2 font-heading">Workspace</Text>
                {orgs.map((org) => (
                  <Pressable
                    className="flex-row items-center justify-between border-border border-b py-3"
                    key={org.id}
                    onPress={() => {
                      void switchOrg(org.id);
                    }}
                  >
                    <Text>{org.name}</Text>
                    {org.id === activeOrg?.id ? (
                      <Text className="text-muted-foreground text-sm">On</Text>
                    ) : null}
                  </Pressable>
                ))}
              </View>
            ) : null}

            <Separator />

            <View className="gap-2">
              <Text className="font-heading">Password</Text>
              <Input
                onChangeText={setCurrentPassword}
                placeholder="Current password"
                secureTextEntry
                value={currentPassword}
              />
              <Input
                onChangeText={setNewPassword}
                placeholder="New password"
                secureTextEntry
                value={newPassword}
              />
              <ActionCluster>
                <Button
                  onPress={() => {
                    void savePassword
                      .mutateAsync({ currentPassword, newPassword })
                      .then(() => {
                        setCurrentPassword("");
                        setNewPassword("");
                      })
                      .catch((error: unknown) => {
                        showMutationError("Could not change password", error);
                      });
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Text>Change password</Text>
                </Button>
              </ActionCluster>
            </View>

            <Separator />

            <View className="gap-2">
              <Text className="font-heading">Timezone</Text>
              <Input
                autoCapitalize="none"
                onChangeText={setTimezone}
                placeholder={timezoneQuery.data ?? "America/New_York"}
                value={timezone}
              />
              <ActionCluster>
                <Button
                  onPress={() => {
                    void saveTimezone
                      .mutateAsync(timezone.trim())
                      .catch((error: unknown) => {
                        showMutationError("Could not save timezone", error);
                      });
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Text>Save timezone</Text>
                </Button>
              </ActionCluster>
            </View>

            <Separator />

            <View className="gap-2">
              <Text className="font-heading">Appearance</Text>
              <View className="flex-row gap-2">
                {THEME_OPTIONS.map((option) => (
                  <Button
                    key={option}
                    onPress={() => {
                      void setPreference(option);
                    }}
                    size="sm"
                    variant={preference === option ? "default" : "outline"}
                  >
                    <Text className="capitalize">{option}</Text>
                  </Button>
                ))}
              </View>
            </View>

            <Separator />

            <View className="gap-2">
              <Text className="font-heading">Server</Text>
              <ServerSwitcher />
              <ActionCluster>
                <Button
                  onPress={() => router.push("/(auth)/connect")}
                  size="sm"
                  variant="outline"
                >
                  <Text>Add server</Text>
                </Button>
              </ActionCluster>
            </View>

            <Button
              onPress={() => {
                void logout()
                  .then(() => {
                    router.replace("/(auth)/login");
                  })
                  .catch((error: unknown) => {
                    Alert.alert(
                      "Sign out issue",
                      error instanceof Error
                        ? error.message
                        : "Please try again."
                    );
                  });
              }}
              variant="destructive"
            >
              <Text>Sign out</Text>
            </Button>
          </View>
        </ScrollView>
      </Screen>
    </>
  );
}
