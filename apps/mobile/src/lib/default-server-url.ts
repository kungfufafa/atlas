import { Platform } from "react-native";

export function defaultServerUrl(): string {
  if (Platform.OS === "android") {
    return "http://10.0.2.2:4310";
  }

  return "http://127.0.0.1:4310";
}
