import type { CreateProviderRequest } from "@atlas/core/contract";
import {
  DEFAULT_SETUP_WORKSPACE_NAME,
  DEFAULT_SETUP_WORKSPACE_SLUG,
  slugifySetupWorkspaceName,
  validateSetupEmail,
  validateSetupName,
  validateSetupPassword,
  validateSetupWorkspaceName,
  validateSetupWorkspaceSlug,
} from "@atlas/core/setup-validation";
import { useRouter } from "expo-router";
import { type ReactNode, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { AuthShell } from "@/components/atlas/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/ui/text";
import { formatAuthError, useAuth } from "@/features/auth/auth-context";
import { useServer } from "@/features/server/server-context";
import { mobileSetupProviders } from "@/features/setup/mobile-providers";
import { useServerQueryClient } from "@/hooks/use-atlas-query";
import { useHealthQuery } from "@/hooks/use-health";
import { cn } from "@/lib/utils";

type Step = 1 | 2 | 3;

export default function SetupScreen() {
  const router = useRouter();
  const { client, isAuthenticated, setup } = useAuth();
  const { activeServer, isCurrentServer } = useServer();
  const queryClient = useServerQueryClient();
  const healthQuery = useHealthQuery();
  const providers = useMemo(() => mobileSetupProviders(), []);

  const [step, setStep] = useState<Step>(isAuthenticated ? 3 : 1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState(
    DEFAULT_SETUP_WORKSPACE_NAME
  );
  const [workspaceSlug, setWorkspaceSlug] = useState(
    DEFAULT_SETUP_WORKSPACE_SLUG
  );
  const [slugEdited, setSlugEdited] = useState(false);
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(providers[0]?.fallbackModelId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedProvider =
    providers.find((provider) => provider.id === providerId) ?? providers[0];

  const heading =
    step === 1
      ? "Create the admin account"
      : step === 2
        ? "Create your workspace"
        : "Connect a provider";

  const goChats = () => {
    router.replace("/(app)/(tabs)/chats");
  };

  const submitAccount = () => {
    const validation =
      validateSetupName(name) ??
      validateSetupEmail(email) ??
      validateSetupPassword(password, confirmPassword);
    if (validation) {
      setError(validation);
      return;
    }
    setError(null);
    setStep(2);
  };

  const submitWorkspace = async () => {
    const trimmedName = workspaceName.trim();
    const trimmedSlug = workspaceSlug.trim().toLowerCase();
    const validation =
      validateSetupWorkspaceName(trimmedName) ??
      validateSetupWorkspaceSlug(trimmedSlug);
    if (validation) {
      setError(validation);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await setup({
        admin: {
          email,
          name: name.trim(),
          password,
        },
        organization: { name: trimmedName, slug: trimmedSlug },
      });
      await healthQuery.refetch();
      setStep(3);
    } catch (caught) {
      setError(formatAuthError(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitProvider = async () => {
    const sourceServerId = activeServer?.id ?? null;
    if (!(client && isCurrentServer(sourceServerId))) {
      setError("Connect a server first.");
      return;
    }
    if (!apiKey.trim()) {
      setError("API key is required.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const request = {
        apiKey: apiKey.trim(),
        model:
          providerId === "opencode_go"
            ? selectedProvider?.fallbackModelId
            : model.trim() || selectedProvider?.fallbackModelId,
        type: providerId,
      } as CreateProviderRequest;
      await client.createProvider(request);
      if (!isCurrentServer(sourceServerId)) {
        throw new Error("The active server changed. Please try again.");
      }
      await queryClient.invalidateQueries();
      goChats();
    } catch (caught) {
      setError(formatAuthError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      footer={
        step === 2 ? (
          <Pressable className="items-center py-4" onPress={() => setStep(1)}>
            <Text className="text-primary">Back</Text>
          </Pressable>
        ) : step === 3 ? (
          <Pressable className="items-center py-4" onPress={goChats}>
            <Text className="text-primary">Skip for now</Text>
          </Pressable>
        ) : null
      }
      title={heading}
    >
      {step === 1 ? (
        <>
          <Field label="Your name">
            <Input onChangeText={setName} value={name} />
          </Field>
          <Field label="Email">
            <Input
              autoCapitalize="none"
              keyboardType="email-address"
              onChangeText={setEmail}
              value={email}
            />
          </Field>
          <Field label="Password">
            <Input
              onChangeText={setPassword}
              placeholder="Password"
              secureTextEntry
              value={password}
            />
          </Field>
          <Field label="Confirm password">
            <Input
              onChangeText={setConfirmPassword}
              placeholder="Password"
              secureTextEntry
              value={confirmPassword}
            />
          </Field>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Field label="Workspace name">
            <Input
              onChangeText={(value) => {
                setWorkspaceName(value);
                if (!slugEdited) {
                  setWorkspaceSlug(slugifySetupWorkspaceName(value));
                }
              }}
              value={workspaceName}
            />
          </Field>
          <Field label="Slug">
            <Input
              autoCapitalize="none"
              onChangeText={(value) => {
                setSlugEdited(true);
                setWorkspaceSlug(value);
              }}
              value={workspaceSlug}
            />
          </Field>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            {providers.map((provider) => (
              <Pressable
                className={cn(
                  "rounded-full border border-border px-3 py-2",
                  provider.id === providerId && "border-primary bg-accent"
                )}
                key={provider.id}
                onPress={() => {
                  setProviderId(provider.id);
                  setModel(provider.fallbackModelId);
                }}
              >
                <Text>{provider.displayName}</Text>
              </Pressable>
            ))}
          </View>
          <Field label="API key">
            <Input
              autoCapitalize="none"
              onChangeText={setApiKey}
              placeholder={selectedProvider?.apiKey.placeholder}
              secureTextEntry
              value={apiKey}
            />
          </Field>
          {providerId === "opencode_go" ? null : (
            <Field label="Model">
              <Input
                autoCapitalize="none"
                onChangeText={setModel}
                value={model}
              />
            </Field>
          )}
        </>
      ) : null}

      {error ? <Text className="text-destructive">{error}</Text> : null}

      {step === 1 ? (
        <Button onPress={submitAccount}>
          <Text>Continue</Text>
        </Button>
      ) : null}
      {step === 2 ? (
        <Button disabled={busy} onPress={() => void submitWorkspace()}>
          <Text>{busy ? "Creating…" : "Create workspace"}</Text>
        </Button>
      ) : null}
      {step === 3 ? (
        <Button disabled={busy} onPress={() => void submitProvider()}>
          <Text>{busy ? "Saving…" : "Continue"}</Text>
        </Button>
      ) : null}
    </AuthShell>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View className="gap-2">
      <Label>{label}</Label>
      {children}
    </View>
  );
}
