import { expect, test } from "bun:test";
import {
  isWhatsAppChatControlCandidate,
  parseWhatsAppChatControl,
} from "./commands";

test.each([
  "bisa diem dulu ga",
  "Tolong diam dulu!",
  "jangan balas dulu",
  "please be quiet",
  "/pause",
  "/mute",
])("pauses on an explicit quiet request: %s", (text) => {
  expect(parseWhatsAppChatControl(text)).toBe("pause");
});

test.each([
  "/resume",
  "/unmute",
  "boleh jawab lagi",
  "silakan balas lagi",
  "resume replies",
])("resumes on an explicit request: %s", (text) => {
  expect(parseWhatsAppChatControl(text)).toBe("resume");
});

test.each([
  "jelaskan kata diam",
  "buat judul 'diem dulu'",
  "lanjut format laporan",
  "can you pause the video",
  "jangan diam dulu",
  "@Alice apa artinya diam?",
])("leaves ordinary instructions untouched: %s", (text) => {
  expect(parseWhatsAppChatControl(text)).toBeNull();
});

test("routes exact controls while preserving other people's mention tokens", () => {
  expect(isWhatsAppChatControlCandidate("bisa diem dulu ga?")).toBe(true);
  expect(isWhatsAppChatControlCandidate("@Alice pause")).toBe(false);
  expect(isWhatsAppChatControlCandidate("/stop")).toBe(true);
  expect(parseWhatsAppChatControl("/STOP")).toBe("stop");
});
