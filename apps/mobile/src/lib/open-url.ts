import * as WebBrowser from "expo-web-browser";
import { Linking } from "react-native";
import { isSafeHttpUrl } from "./url-safety";

export { isSafeHttpUrl } from "./url-safety";

export async function openExternalUrl(url: string): Promise<void> {
  if (!isSafeHttpUrl(url)) {
    throw new Error("Invalid URL.");
  }

  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    try {
      await Linking.openURL(url);
    } catch {
      throw new Error("Could not open URL.");
    }
  }
}
