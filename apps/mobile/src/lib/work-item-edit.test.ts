import { expect, test } from "bun:test";
import {
  buildAutomationUpdateRequest,
  buildTaskUpdateRequest,
} from "./work-item-edit";

test("keeps an inaccessible task profile unchanged without resubmitting it", () => {
  expect(
    buildTaskUpdateRequest({
      currentProfileId: "restricted-profile",
      description: " Updated ",
      profileId: "restricted-profile",
      prompt: " Do the work ",
      title: " Task ",
    })
  ).toEqual({
    description: "Updated",
    prompt: "Do the work",
    title: "Task",
  });
});

test("includes a newly selected task profile without changing task status", () => {
  expect(
    buildTaskUpdateRequest({
      currentProfileId: "restricted-profile",
      description: "",
      profileId: "visible-profile",
      prompt: "Prompt",
      title: "Task",
    })
  ).toEqual({
    description: "",
    profileId: "visible-profile",
    prompt: "Prompt",
    title: "Task",
  });
});

test("keeps an inaccessible automation profile unchanged", () => {
  expect(
    buildAutomationUpdateRequest({
      currentProfileId: "restricted-profile",
      description: " Daily ",
      name: " Digest ",
      profileId: "restricted-profile",
      prompt: " Summarize ",
    })
  ).toEqual({
    description: "Daily",
    name: "Digest",
    prompt: "Summarize",
  });
});
