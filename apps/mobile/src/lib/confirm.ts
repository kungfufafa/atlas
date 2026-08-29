import { Alert, Platform } from "react-native";

function confirmChoice(input: {
  confirmLabel: string;
  destructive?: boolean;
  message?: string;
  onConfirm: () => void;
  title: string;
}): void {
  // react-native-web's Alert.alert is a no-op, so web must use the browser
  // confirm dialog or HTTP/local-server protections never run.
  if (Platform.OS === "web") {
    const accepted = globalThis.confirm(
      input.message ? `${input.title}\n\n${input.message}` : input.title
    );
    if (accepted) {
      input.onConfirm();
    }
    return;
  }

  Alert.alert(input.title, input.message, [
    { style: "cancel", text: "Cancel" },
    {
      onPress: input.onConfirm,
      style: input.destructive ? "destructive" : "default",
      text: input.confirmLabel,
    },
  ]);
}

export function confirmDestructive(input: {
  confirmLabel?: string;
  message?: string;
  onConfirm: () => void;
  title: string;
}): void {
  confirmChoice({
    confirmLabel: input.confirmLabel ?? "Delete",
    destructive: true,
    message: input.message,
    onConfirm: input.onConfirm,
    title: input.title,
  });
}

export function confirmInsecureConnection(input: {
  onConfirm: () => void;
}): void {
  confirmChoice({
    confirmLabel: "Continue",
    message:
      "HTTP is only appropriate for your device or a trusted private network. Anyone on that network can read or alter this traffic. Use HTTPS for a remote Atlas server.",
    onConfirm: input.onConfirm,
    title: "Unencrypted local connection",
  });
}

export function confirmServerRemoval(input: {
  isActive: boolean;
  isLast: boolean;
  name: string;
  onConfirm: () => void;
}): void {
  confirmDestructive({
    confirmLabel: "Remove",
    message: serverRemovalMessage(input),
    onConfirm: input.onConfirm,
    title: "Remove server",
  });
}

export function serverRemovalMessage(input: {
  isActive: boolean;
  isLast: boolean;
  name: string;
}): string {
  if (input.isActive && input.isLast) {
    return `Remove ${input.name} and its saved session from this device? This is the server you are using now, and it is the last saved server.`;
  }
  if (input.isActive) {
    return `Remove ${input.name} and its saved session from this device? This is the server you are using now.`;
  }
  if (input.isLast) {
    return `Remove ${input.name} and its saved session from this device? This is the last saved server.`;
  }
  return `Remove ${input.name} and its saved session from this device?`;
}
