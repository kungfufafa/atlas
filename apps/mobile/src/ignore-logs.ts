import { LogBox } from "react-native";

LogBox.ignoreLogs([
  "SafeAreaView has been deprecated",
  "Can not attach worklet handlers for `react-native-keyboard-controller`",
]);

const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const first = args[0];
  if (
    typeof first === "string" &&
    first.includes("SafeAreaView has been deprecated")
  ) {
    return;
  }
  originalWarn(...args);
};
