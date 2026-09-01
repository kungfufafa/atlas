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
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { AuthShell } from "@/components/atlas/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { formatAuthError, useAuth } from "@/features/auth/auth-context";
import { useServer } from "@/features/server/server-context";
import { mobileSetupProviders } from "@/features/setup/mobile-providers";
import { useServerQueryClient } from "@/hooks/use-atlas-query";
import { useHealthQuery } from "@/hooks/use-health";
import { useTimezoneQuery, useUserContextQuery } from "@/hooks/use-workspace";
import { AUTH_PLACEHOLDERS } from "@/lib/auth-placeholders";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

type Step = 1 | 2 | 3 | 4;

const DEVICE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export default function SetupScreen() {
  const router = useRouter();
  const { client, isAuthenticated, setup } = useAuth();
  const { activeServer, isCurrentServer } = useServer();
  const queryClient = useServerQueryClient();
  const healthQuery = useHealthQuery();
  const timezoneQuery = useTimezoneQuery();
  const userContextQuery = useUserContextQuery();
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
  const [userContext, setUserContext] = useState("");
  const [userContextEdited, setUserContextEdited] = useState(false);
  const [timezone, setTimezone] = useState(DEVICE_TIMEZONE ?? "UTC");
  const [timezoneEdited, setTimezoneEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedProvider =
    providers.find((provider) => provider.id === providerId) ?? providers[0];
  const isOpencodeProvider = selectedProvider?.id === "opencode_go";
  const isApiKeyRequired = selectedProvider?.apiKey.requirement === "required";
  const modelTrimmed = model.trim();
  const apiKeyTrimmed = apiKey.trim();
  const canSubmitProvider = !isApiKeyRequired || apiKeyTrimmed.length > 0;
  const personalisationLoadError =
    timezoneQuery.error ?? userContextQuery.error;
  const personalisationLoading =
    timezoneQuery.isLoading || userContextQuery.isLoading;

  useEffect(() => {
    if (!(timezoneEdited || !timezoneQuery.data)) {
      setTimezone(timezoneQuery.data);
    }
  }, [timezoneEdited, timezoneQuery.data]);

  useEffect(() => {
    if (!(userContextEdited || !userContextQuery.data)) {
      setUserContext(userContextQuery.data.content ?? "");
    }
  }, [userContextEdited, userContextQuery.data]);

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
        : step === 3
          ? {
              description:
                "Add an AI provider now, or do it later from workspace settings.",
              title: "Connect an AI provider",
            }
          : {
              description:
                "Add optional context so your agents understand how you work.",
              title: "Tell us about yourself",
            };

  const goChats = () => {
    router.replace("/(app)/(tabs)/chats");
  };
  const goPersonalisation = () => {
    setError(null);
    setStep(4);
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
      goPersonalisation();
    } catch (caught) {
      setError(formatAuthError(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitPersonalisation = async () => {
    const sourceServerId = activeServer?.id ?? null;
    if (!(client && isCurrentServer(sourceServerId))) {
      setError("Connect a server first.");
      return;
    }

    const timezoneTrimmed = timezone.trim();
    if (!(timezoneTrimmed && isValidTimezone(timezoneTrimmed))) {
      setError("Enter a valid IANA timezone, for example Asia/Jakarta.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (timezoneTrimmed !== timezoneQuery.data?.trim()) {
        await client.setTimezone(timezoneTrimmed);
      }
      const contextTrimmed = userContext.trim();
      await client.initUserContext();
      if (userContextEdited) {
        await client.writeUserContext(contextTrimmed);
      }
      if (!isCurrentServer(sourceServerId)) {
        throw new Error("The active server changed. Please try again.");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.timezone }),
        queryClient.invalidateQueries({ queryKey: queryKeys.userContext }),
      ]);
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
          <Pressable
            className={cn("items-center py-4", busy && "opacity-50")}
            disabled={busy}
            onPress={() => setStep(1)}
          >
            <Text className="text-primary">Back to account</Text>
          </Pressable>
        ) : step === 3 ? (
          <Pressable
            className={cn("items-center py-4", busy && "opacity-50")}
            disabled={busy}
            onPress={goPersonalisation}
          >
            <Text className="text-primary">I’ll add this later</Text>
          </Pressable>
        ) : step === 4 ? (
          <View className="gap-2">
            <Pressable
              className={cn("items-center py-2", busy && "opacity-50")}
              disabled={busy}
              onPress={() => setStep(3)}
            >
              <Text className="text-primary">Back to provider</Text>
            </Pressable>
            <Pressable
              className={cn("items-center py-2", busy && "opacity-50")}
              disabled={busy}
              onPress={goChats}
            >
              <Text className="text-primary">Set up later</Text>
            </Pressable>
          </View>
        ) : null
      }
      progress={{ current: step, total: 4 }}
      title={stepContent.title}
    >
      {step === 1 ? (
        <>
          <Field label="Your name">
            <Input
              onChangeText={setName}
              placeholder={AUTH_PLACEHOLDERS.name}
              value={name}
            />
          </Field>
          <Field label="Email">
            <Input
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder={AUTH_PLACEHOLDERS.email}
              value={email}
            />
          </Field>
          <Field label="Password">
            <PasswordInput
              autoCapitalize="none"
              autoComplete="new-password"
              autoCorrect={false}
              onChangeText={setPassword}
              placeholder={AUTH_PLACEHOLDERS.password}
              value={password}
            />
          </Field>
          <Field label="Confirm password">
            <PasswordInput
              autoCapitalize="none"
              autoComplete="new-password"
              autoCorrect={false}
              onChangeText={setConfirmPassword}
              placeholder={AUTH_PLACEHOLDERS.password}
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
              placeholder={AUTH_PLACEHOLDERS.workspaceName}
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
              placeholder={AUTH_PLACEHOLDERS.workspaceSlug}
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
                  if (provider.id !== providerId) {
                    setApiKey("");
                  }
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
                placeholder="Select a model"
                value={model}
              />
            </Field>
          )}
        </>
      ) : null}

      {step === 4 ? (
        <>
          <Field label="Personal context">
            <Textarea
              className="min-h-40"
              editable={!(busy || personalisationLoading)}
              onChangeText={(value) => {
                setUserContextEdited(true);
                setUserContext(value);
              }}
              placeholder="How should your agents address you, and what preferences should they remember?"
              value={userContext}
            />
          </Field>
          <Field label="Timezone">
            <Input
              autoCapitalize="none"
              autoCorrect={false}
              editable={!(busy || personalisationLoading)}
              onChangeText={(value) => {
                setTimezoneEdited(true);
                setTimezone(value);
              }}
              placeholder="Asia/Jakarta"
              value={timezone}
            />
          </Field>
          <Button
            disabled={busy || personalisationLoading}
            onPress={() => {
              setTimezoneEdited(true);
              setTimezone(DEVICE_TIMEZONE ?? "UTC");
            }}
            variant="outline"
          >
            <Text>Use device timezone</Text>
          </Button>
        </>
      ) : null}

      {error ? <Text className="text-destructive">{error}</Text> : null}
      {step === 4 && personalisationLoadError ? (
        <>
          <Text className="text-destructive">
            {formatAuthError(personalisationLoadError)}
          </Text>
          <Button
            disabled={personalisationLoading}
            onPress={() => {
              void Promise.all([
                timezoneQuery.refetch(),
                userContextQuery.refetch(),
              ]);
            }}
            variant="outline"
          >
            <Text>Retry loading settings</Text>
          </Button>
        </>
      ) : null}

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
      {step === 4 ? (
        <Button
          disabled={
            busy ||
            personalisationLoading ||
            Boolean(personalisationLoadError) ||
            !timezone.trim()
          }
          onPress={() => void submitPersonalisation()}
        >
          <Text>{busy ? "Saving…" : "Start chatting"}</Text>
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
