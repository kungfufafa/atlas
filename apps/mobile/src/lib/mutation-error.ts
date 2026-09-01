import { formatError } from "@atlas/client";
import { Alert, Platform } from "react-native";

export function showMutationError(title: string, error: unknown): void {
  const message = formatError(error);
  if (Platform.OS === "web") {
    globalThis.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}
