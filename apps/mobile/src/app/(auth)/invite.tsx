import { validateSetupPassword } from "@atlas/core/setup-validation";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { AuthShell } from "@/components/atlas/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Text } from "@/components/ui/text";
import { formatAuthError, useAuth } from "@/features/auth/auth-context";
import { useServer } from "@/features/server/server-context";
import { useHealthQuery } from "@/hooks/use-health";
import { tokenFromInviteInput } from "@/lib/invite";

export default function InviteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const { activeServer } = useServer();
  const { acceptInvite, client, isAuthenticated } = useAuth();
  const healthQuery = useHealthQuery();
  const [tokenInput, setTokenInput] = useState(String(params.token ?? ""));
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [previewRole, setPreviewRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const token = tokenFromInviteInput(tokenInput);
  const tokenTrimmed = token.trim();
  const passwordTrimmed = password.trim();
  const confirmPasswordTrimmed = confirmPassword.trim();
  const canSubmit =
    !busy &&
    Boolean(tokenTrimmed) &&
    (isAuthenticated ||
      (passwordTrimmed.length > 0 && confirmPasswordTrimmed.length > 0));

  useEffect(() => {
    if (params.token) {
      setTokenInput(String(params.token));
    }
  }, [params.token]);

  useEffect(() => {
    if (!(client && token)) {
      setPreviewName(null);
      setPreviewRole(null);
      return;
    }
    let cancelled = false;
    void client
      .previewOrgInvite(token)
      .then((preview) => {
        if (!cancelled) {
          setPreviewName(preview.orgName);
          setPreviewRole(preview.role);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setPreviewName(null);
          setPreviewRole(null);
          setError(formatAuthError(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  if (!activeServer) {
    return <Redirect href="/(auth)/connect" />;
  }

  if (healthQuery.data?.userConfigured === false) {
    return <Redirect href="/(auth)/setup" />;
  }

  const goSignIn = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/(auth)/login");
  };

  const submit = async () => {
    if (!tokenTrimmed) {
      setError("Invite token is required.");
      return;
    }
    if (!isAuthenticated) {
      const passwordError = validateSetupPassword(
        passwordTrimmed,
        confirmPasswordTrimmed
      );
      if (passwordError) {
        setError(passwordError);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(
        tokenTrimmed,
        isAuthenticated ? undefined : passwordTrimmed
      );
      router.replace("/(app)/(tabs)/chats");
    } catch (caught) {
      setError(formatAuthError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      description="Paste the invite link your workspace admin sent you."
      footer={
        <Button
          accessibilityLabel="Sign in"
          className="w-full"
          onPress={goSignIn}
          variant="outline"
        >
          <Text>Sign in</Text>
        </Button>
      }
      footerClassName="mt-4"
      onBack={goSignIn}
      title="Join a workspace"
    >
      <View className="gap-2">
        <Label>Invite</Label>
        <Input
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setTokenInput}
          placeholder="Token or invite URL"
          value={tokenInput}
        />
      </View>
      {previewName ? (
        <View className="rounded-lg border border-border px-3 py-3">
          <Text className="font-heading">{previewName}</Text>
          {previewRole ? (
            <Text className="mt-1 text-muted-foreground text-sm">
              {previewRole}
            </Text>
          ) : null}
        </View>
      ) : null}
      {previewName && !isAuthenticated ? (
        <>
          <View className="gap-2">
            <Label>Password</Label>
            <PasswordInput
              onChangeText={setPassword}
              placeholder="Password"
              value={password}
            />
          </View>
          <View className="gap-2">
            <Label>Confirm password</Label>
            <PasswordInput
              onChangeText={setConfirmPassword}
              placeholder="Password"
              value={confirmPassword}
            />
          </View>
        </>
      ) : null}
      {error ? <Text className="text-destructive">{error}</Text> : null}
      {previewName ? (
        <Button disabled={!canSubmit} onPress={() => void submit()}>
          <Text>{busy ? "Joining…" : "Join workspace"}</Text>
        </Button>
      ) : null}
    </AuthShell>
  );
}
