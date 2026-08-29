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
import { PasswordInput } from "@/components/ui/password-input";
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
  const isOpencodeProvider = selectedProvider?.id === "opencode_go";
  const isApiKeyRequired = selectedProvider?.apiKey.requirement === "required";
  const modelTrimmed = model.trim();
  const apiKeyTrimmed = apiKey.trim();
  const canSubmitProvider = !isApiKeyRequired || apiKeyTrimmed.length > 0;

  const stepContent =
    step === 1
      ? {
          description:
            "This account manages your workspace, teammates, and settings.",
          title: "Create your admin account",
        }
      : step === 2
        ? {
            description: "This is the shared home your team will join.",
            title: "Name your workspace",
          }
        : {
            description:
              "Add an AI provider now, or do it later from workspace settings.",
            title: "Connect an AI provider",
          };

  const goChats = () => {
    router.replace("/(app)/(tabs)/chats");
  };
  const nameTrimmed = name.trim();
  const emailTrimmed = email.trim();
  const passwordTrimmed = password.trim();
  const confirmPasswordTrimmed = confirmPassword.trim();
  const canContinueSetup =
    nameTrimmed.length > 0 &&
    emailTrimmed.length > 0 &&
    passwordTrimmed.length > 0 &&
    confirmPasswordTrimmed.length > 0;

  const submitAccount = () => {
    const validation =
      validateSetupName(nameTrimmed) ??
      validateSetupEmail(emailTrimmed) ??
      validateSetupPassword(passwordTrimmed, confirmPasswordTrimmed);
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
          email: emailTrimmed,
          name: nameTrimmed,
          password: passwordTrimmed,
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
    if (isApiKeyRequired && !apiKeyTrimmed) {
      setError("API key is required.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const request = {
        apiKey: isApiKeyRequired ? apiKeyTrimmed : "",
        model: isOpencodeProvider
          ? selectedProvider?.fallbackModelId
          : modelTrimmed || selectedProvider?.fallbackModelId,
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
      description={stepContent.description}
      footer={
        step === 2 ? (
          <Pressable className="items-center py-4" onPress={() => setStep(1)}>
            <Text className="text-primary">Back to account</Text>
          </Pressable>
        ) : step === 3 ? (
          <Pressable className="items-center py-4" onPress={goChats}>
            <Text className="text-primary">I’ll add this later</Text>
          </Pressable>
        ) : null
      }
      progress={{ current: step, total: 3 }}
      title={stepContent.title}
    >
      {step === 1 ? (
        <>
          <Field label="Your name">
            <Input onChangeText={setName} value={name} />
          </Field>
          <Field label="Email">
            <Input
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              onChangeText={setEmail}
              value={email}
            />
          </Field>
          <Field label="Password">
            <PasswordInput
              autoCapitalize="none"
              autoComplete="new-password"
              autoCorrect={false}
              onChangeText={setPassword}
              placeholder="Password"
              value={password}
            />
          </Field>
          <Field label="Confirm password">
            <PasswordInput
              autoCapitalize="none"
              autoComplete="new-password"
              autoCorrect={false}
              onChangeText={setConfirmPassword}
              placeholder="Password"
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
              autoCorrect={false}
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
          <Text className="font-heading">Choose a provider</Text>
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
                  setModel(provider.fallbackModelId ?? "");
                }}
              >
                <Text>{provider.displayName}</Text>
              </Pressable>
            ))}
          </View>
          <Field label="API key">
            <PasswordInput
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              onChangeText={setApiKey}
              placeholder={selectedProvider?.apiKey.placeholder}
              value={apiKey}
            />
          </Field>
          {isOpencodeProvider ? null : (
            <Field label="Model">
              <Input
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setModel}
                placeholder={`Model (default: ${selectedProvider?.fallbackModelId})`}
                value={model}
              />
            </Field>
          )}
        </>
      ) : null}

      {error ? <Text className="text-destructive">{error}</Text> : null}

      {step === 1 ? (
        <Button disabled={!canContinueSetup} onPress={submitAccount}>
          <Text>Continue</Text>
        </Button>
      ) : null}
      {step === 2 ? (
        <Button disabled={busy} onPress={() => void submitWorkspace()}>
          <Text>{busy ? "Creating…" : "Create workspace"}</Text>
        </Button>
      ) : null}
      {step === 3 ? (
        <Button
          disabled={busy || !canSubmitProvider}
          onPress={() => void submitProvider()}
        >
          <Text>{busy ? "Saving…" : "Save and continue"}</Text>
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
