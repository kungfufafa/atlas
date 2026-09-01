import type {
  UpdateAutomationRequest,
  UpdateTaskRequest,
} from "@atlas/core/contract";

interface WorkItemProfileDraft {
  currentProfileId: string;
  description: string;
  profileId: string;
  prompt: string;
}

interface TaskEditDraft extends WorkItemProfileDraft {
  title: string;
}

interface AutomationEditDraft extends WorkItemProfileDraft {
  name: string;
}

export function buildTaskUpdateRequest(
  draft: TaskEditDraft
): UpdateTaskRequest {
  return {
    description: draft.description.trim(),
    prompt: draft.prompt.trim(),
    title: draft.title.trim(),
    ...(draft.profileId === draft.currentProfileId
      ? {}
      : { profileId: draft.profileId }),
  };
}

export function buildAutomationUpdateRequest(
  draft: AutomationEditDraft
): UpdateAutomationRequest {
  return {
    description: draft.description.trim(),
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    ...(draft.profileId === draft.currentProfileId
      ? {}
      : { profileId: draft.profileId }),
  };
}
