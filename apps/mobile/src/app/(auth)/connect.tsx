import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AuthShell } from "@/components/atlas/auth-shell";
import { ServerSwitcher } from "@/components/atlas/server-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/ui/text";
import { useServer } from "@/features/server/server-context";
import { confirmInsecureConnection } from "@/lib/confirm";
import { checkAtlasServer } from "@/lib/server-health";
import {
  evaluateServerConnection,
  isInsecureServerUrl,
} from "@/lib/server-url";

export default function ConnectScreen() {
  const router = useRouter();
  const { activeServer, addServer, servers } = useServer();
  const [url, setUrl] = useState(activeServer?.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const activeCheckRef = useRef<AbortController | null>(null);
  const connectionAttemptRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      connectionAttemptRef.current += 1;
      activeCheckRef.current?.abort();
    };
  }, []);

  const finish = () => {
    router.replace("/");
  };

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/(auth)/login");
  };

  const connectTo = async (rawUrl: string, insecureConfirmed = false) => {
    if (!isMountedRef.current) {
      return;
    }

    const attempt = ++connectionAttemptRef.current;
    const decision = evaluateServerConnection(rawUrl, { insecureConfirmed });
    if (decision.status === "invalid") {
      setError(
        "Enter an Atlas URL. Remote servers must use HTTPS, for example https://atlas.example.com."
      );
      return;
    }

    setError(null);

    if (decision.status === "needs-insecure-confirmation") {
      confirmInsecureConnection({
        onConfirm: () => {
          if (
            isMountedRef.current &&
            connectionAttemptRef.current === attempt
          ) {
            void connectTo(decision.url, true);
          }
        },
      });
      return;
    }

    const nextUrl = decision.url;

    activeCheckRef.current?.abort();
    const controller = new AbortController();
    activeCheckRef.current = controller;
    setIsSubmitting(true);
    try {
      await checkAtlasServer(nextUrl, {
        allowInsecure: isInsecureServerUrl(nextUrl),
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        activeCheckRef.current !== controller ||
        connectionAttemptRef.current !== attempt ||
        !isMountedRef.current
      ) {
        return;
      }
      await addServer(nextUrl, {
        allowInsecure: isInsecureServerUrl(nextUrl),
      });
      if (connectionAttemptRef.current !== attempt || !isMountedRef.current) {
        return;
      }
      finish();
    } catch (caught) {
      if (
        controller.signal.aborted ||
        activeCheckRef.current !== controller ||
        connectionAttemptRef.current !== attempt ||
        !isMountedRef.current
      ) {
        return;
      }
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not reach that Atlas server."
      );
    } finally {
      if (
        activeCheckRef.current === controller &&
        connectionAttemptRef.current === attempt &&
        isMountedRef.current
      ) {
        activeCheckRef.current = null;
        setIsSubmitting(false);
      }
    }
  };

  return (
    <AuthShell onBack={goBack} title="Server">
      <View className="gap-2">
        <Label>Server URL</Label>
        <Input
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting}
          keyboardType="url"
          onChangeText={setUrl}
          placeholder="https://atlas.example.com"
          value={url}
        />
      </View>
      {error ? <Text className="text-destructive">{error}</Text> : null}
      <Button
        disabled={isSubmitting}
        onPress={() => {
          void connectTo(url);
        }}
      >
        <Text>{isSubmitting ? "Checking…" : "Continue"}</Text>
      </Button>
      {servers.length > 0 ? (
        <View className="mt-4 gap-3">
          <Text className="font-heading">Saved</Text>
          <ServerSwitcher
            disabled={isSubmitting}
            onBeforeChange={() => {
              connectionAttemptRef.current += 1;
              activeCheckRef.current?.abort();
            }}
            onSelect={() => {
              finish();
            }}
          />
        </View>
      ) : null}
    </AuthShell>
  );
}
