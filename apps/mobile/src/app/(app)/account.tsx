import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { ActionCluster } from "@/components/atlas/action-cluster";
import { Screen } from "@/components/atlas/screen";
import { ServerSwitcher } from "@/components/atlas/server-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/features/auth/auth-context";
import { useAppTheme } from "@/features/theme/theme-provider";
import { useAtlasMutation } from "@/hooks/use-atlas-query";
import { useTimezoneQuery } from "@/hooks/use-workspace";
import { showMutationError } from "@/lib/mutation-error";
import type { ThemePreference } from "@/lib/storage";

const THEME_OPTIONS: ThemePreference[] = ["system", "light", "dark"];
const FALLBACK_DEVICE_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone;

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

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

  useEffect(() => {
    if (timezoneQuery.data) {
      setTimezone((current) => current || timezoneQuery.data);
    }
  }, [timezoneQuery.data]);

  const timezoneTrimmed = timezone.trim();
  const hasTimezoneValue = timezoneTrimmed.length > 0;
  const isTimezoneInvalid =
    hasTimezoneValue && !isValidTimezone(timezoneTrimmed);
  const nameTrimmed = name.trim();
  const currentPasswordTrimmed = currentPassword.trim();
  const newPasswordTrimmed = newPassword.trim();

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: "Account" }} />
      <Screen padded>
        <ScrollView
          contentContainerStyle={{
            paddingBottom: 40,
            paddingTop: 0,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View className="gap-8">
            <View className="gap-3">
              <Text className="font-heading text-base">{user?.email}</Text>
              <Label>Name</Label>
              <Input onChangeText={setName} value={name} />
              <ActionCluster>
                <Button
                  disabled={saveProfile.isPending || !nameTrimmed}
                  onPress={() => {
                    void saveProfile
                      .mutateAsync(nameTrimmed)
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
                  <Text>{saveProfile.isPending ? "Saving…" : "Save name"}</Text>
                </Button>
              </ActionCluster>
            </View>

            {orgs.length > 1 ? (
              <View className="gap-1">
                <Text className="font-heading">Workspace</Text>
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

            <View className="gap-3">
              <Text className="font-heading">Password</Text>
              <PasswordInput
                autoCapitalize="none"
                autoComplete="current-password"
                autoCorrect={false}
                onChangeText={setCurrentPassword}
                placeholder="Current password"
                value={currentPassword}
              />
              <PasswordInput
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect={false}
                onChangeText={setNewPassword}
                placeholder="New password"
                value={newPassword}
              />
              <ActionCluster>
                <Button
                  disabled={
                    savePassword.isPending ||
                    !currentPasswordTrimmed ||
                    !newPasswordTrimmed
                  }
                  onPress={() => {
                    void savePassword
                      .mutateAsync({
                        currentPassword: currentPasswordTrimmed,
                        newPassword: newPasswordTrimmed,
                      })
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
                  <Text>
                    {savePassword.isPending ? "Changing…" : "Change password"}
                  </Text>
                </Button>
              </ActionCluster>
            </View>

            <Separator />

            <View className="gap-3">
              <Text className="font-heading">Timezone</Text>
              <Input
                autoCapitalize="none"
                onChangeText={setTimezone}
                placeholder={
                  timezoneQuery.data ??
                  FALLBACK_DEVICE_TIMEZONE ??
                  "America/New_York"
                }
                value={timezone}
              />
              {hasTimezoneValue && isTimezoneInvalid ? (
                <Text className="text-destructive text-sm">
                  Enter a valid IANA timezone (example: Asia/Jakarta).
                </Text>
              ) : null}
              <Button
                onPress={() => {
                  setTimezone(
                    FALLBACK_DEVICE_TIMEZONE ?? timezoneQuery.data ?? ""
                  );
                }}
                size="sm"
                variant="outline"
              >
                <Text>Use device timezone</Text>
              </Button>
              <ActionCluster>
                <Button
                  disabled={
                    saveTimezone.isPending ||
                    isTimezoneInvalid ||
                    !hasTimezoneValue
                  }
                  onPress={() => {
                    void saveTimezone
                      .mutateAsync(timezoneTrimmed)
                      .catch((error: unknown) => {
                        showMutationError("Could not save timezone", error);
                      });
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Text>
                    {saveTimezone.isPending
                      ? "Saving timezone…"
                      : "Save timezone"}
                  </Text>
                </Button>
              </ActionCluster>
            </View>

            <Separator />

            <View className="gap-3">
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

            <View className="gap-3">
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
              className="mt-1"
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
