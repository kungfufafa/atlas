import { zodResolver } from "@hookform/resolvers/zod";
import { Redirect, useRouter } from "expo-router";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { View } from "react-native";
import { z } from "zod";
import { AuthShell } from "@/components/atlas/auth-shell";
import { ServerLoginRow } from "@/components/atlas/server-login-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { formatAuthError, useAuth } from "@/features/auth/auth-context";
import { useServer } from "@/features/server/server-context";
import { useHealthQuery } from "@/hooks/use-health";

const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type FormValues = z.infer<typeof schema>;

export default function LoginScreen() {
  const router = useRouter();
  const { activeServer } = useServer();
  const { login } = useAuth();
  const healthQuery = useHealthQuery();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    defaultValues: { email: "", password: "" },
    resolver: zodResolver(schema),
  });

  if (activeServer && healthQuery.isLoading && !healthQuery.data) {
    return <Spinner className="flex-1 bg-background" />;
  }

  if (activeServer && healthQuery.data?.userConfigured === false) {
    return <Redirect href="/(auth)/setup" />;
  }

  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    if (!activeServer) {
      router.push("/(auth)/connect");
      return;
    }
    setError(null);
    try {
      await login(email, password);
      router.replace("/");
    } catch (caught) {
      setError(formatAuthError(caught));
    }
  });

  return (
    <AuthShell
      footer={
        <Button
          accessibilityLabel="Join a workspace"
          className="w-full"
          onPress={() => router.push("/(auth)/invite")}
          variant="outline"
        >
          <Text>Join a workspace</Text>
        </Button>
      }
      title="Sign in"
    >
      <ServerLoginRow disabled={form.formState.isSubmitting} />
      <View className="gap-2">
        <Label>Email</Label>
        <Controller
          control={form.control}
          name="email"
          render={({ field }) => (
            <Input
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              onChangeText={field.onChange}
              placeholder="you@example.com"
              value={field.value}
            />
          )}
        />
        {form.formState.errors.email?.message ? (
          <Text className="text-destructive text-sm">
            {form.formState.errors.email.message}
          </Text>
        ) : null}
      </View>
      <View className="gap-2">
        <Label>Password</Label>
        <Controller
          control={form.control}
          name="password"
          render={({ field }) => (
            <PasswordInput
              autoComplete="password"
              onChangeText={field.onChange}
              placeholder="Password"
              value={field.value}
            />
          )}
        />
        {form.formState.errors.password?.message ? (
          <Text className="text-destructive text-sm">
            {form.formState.errors.password.message}
          </Text>
        ) : null}
      </View>
      {healthQuery.isError ? (
        <Text className="text-destructive">
          Could not reach this Atlas server.
        </Text>
      ) : null}
      {error ? <Text className="text-destructive">{error}</Text> : null}
      <Button
        disabled={form.formState.isSubmitting || !activeServer}
        onPress={onSubmit}
      >
        <Text>{form.formState.isSubmitting ? "Signing in…" : "Sign in"}</Text>
      </Button>
    </AuthShell>
  );
}
