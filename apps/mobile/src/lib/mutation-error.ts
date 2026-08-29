import { formatError } from "@atlas/client";
import { Alert } from "react-native";

export function showMutationError(title: string, error: unknown): void {
  Alert.alert(title, formatError(error));
}
