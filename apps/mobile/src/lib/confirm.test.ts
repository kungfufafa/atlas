import { afterEach, expect, mock, test } from "bun:test";

const alert = mock(
  (
    _title: string,
    _message: string | undefined,
    buttons: Array<{ onPress?: () => void; text: string }>
  ) => {
    buttons.at(-1)?.onPress?.();
  }
);
let platformOs = "ios";
const confirm = mock((_message?: string) => true);

mock.module("react-native", () => ({
  Alert: { alert },
  Platform: {
    get OS() {
      return platformOs;
    },
  },
}));

const { confirmInsecureConnection, confirmServerRemoval } = await import(
  "./confirm"
);

afterEach(() => {
  alert.mockClear();
  confirm.mockClear();
  confirm.mockImplementation(() => true);
  platformOs = "ios";
  Reflect.deleteProperty(globalThis, "confirm");
});

test("native HTTP confirmation continues only from the confirm action", () => {
  let continued = false;
  confirmInsecureConnection({
    onConfirm: () => {
      continued = true;
    },
  });

  expect(continued).toBe(true);
  expect(alert).toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

test("web HTTP confirmation uses the browser dialog because Alert is a no-op", () => {
  platformOs = "web";
  globalThis.confirm = confirm;
  let continued = false;

  confirmInsecureConnection({
    onConfirm: () => {
      continued = true;
    },
  });

  expect(confirm).toHaveBeenCalled();
  expect(continued).toBe(true);
  expect(alert).not.toHaveBeenCalled();
});

test("cancelling a last-server removal does not delete it", () => {
  platformOs = "web";
  confirm.mockImplementation(() => false);
  globalThis.confirm = confirm;
  let removed = false;

  confirmServerRemoval({
    isActive: true,
    isLast: true,
    name: "127.0.0.1:4310",
    onConfirm: () => {
      removed = true;
    },
  });

  expect(removed).toBe(false);
});
