interface TurnState {
  assignedToolIds: Set<string>;
  createdToolIds: Set<string>;
  profileUpdateDecision: "confirm" | "deny" | "unknown";
  turnIndex: number;
}

interface PendingProfileUpdate {
  draftHash: string;
  expiresAt: number;
  orgId: string;
  profileId: string;
  proposedAtTurn: number;
  userId: string;
}

export class SuperAgentSessionState {
  private readonly turns = new Map<string, TurnState>();
  private readonly pendingProfileNames = new Map<string, Set<string>>();
  private readonly pendingProfileUpdates = new Map<
    string,
    PendingProfileUpdate
  >();

  constructor(
    private readonly options: {
      confirmationTtlMs?: number;
      now?: () => number;
    } = {}
  ) {}

  beginTurn(sessionId: string, userMessage = ""): void {
    const turnIndex = (this.turns.get(sessionId)?.turnIndex ?? 0) + 1;
    this.turns.set(sessionId, {
      assignedToolIds: new Set(),
      createdToolIds: new Set(),
      profileUpdateDecision: profileUpdateDecision(userMessage),
      turnIndex,
    });
  }

  markToolCreated(sessionId: string | undefined, toolId: string): void {
    if (!sessionId) {
      return;
    }

    this.turnFor(sessionId).createdToolIds.add(toolId);
  }

  canAssignTool(sessionId: string | undefined, toolId: string): boolean {
    if (!sessionId) {
      return true;
    }

    const turn = this.turns.get(sessionId);

    if (!turn?.createdToolIds.has(toolId)) {
      return true;
    }

    return !turn.assignedToolIds.has(toolId);
  }

  markToolAssigned(sessionId: string | undefined, toolId: string): void {
    if (!sessionId) {
      return;
    }

    this.turnFor(sessionId).assignedToolIds.add(toolId);
  }

  clearSession(sessionId: string): void {
    this.turns.delete(sessionId);
    this.pendingProfileNames.delete(sessionId);
    this.pendingProfileUpdates.delete(sessionId);
  }

  consumeProfileUpdateConfirmation(input: {
    draftHash: string;
    orgId: string;
    profileId: string;
    sessionId: string;
    userId: string;
  }): "cancelled" | "confirmed" | "needs_confirmation" {
    const now = this.options.now?.() ?? Date.now();
    const turnIndex = this.turns.get(input.sessionId)?.turnIndex ?? 0;
    const pending = this.pendingProfileUpdates.get(input.sessionId);
    const matches =
      pending?.draftHash === input.draftHash &&
      pending.orgId === input.orgId &&
      pending.profileId === input.profileId &&
      pending.userId === input.userId;
    const isLaterTurn =
      pending !== undefined && turnIndex > pending.proposedAtTurn;
    const decision = this.turns.get(input.sessionId)?.profileUpdateDecision;

    if (pending && isLaterTurn && decision === "deny") {
      this.pendingProfileUpdates.delete(input.sessionId);
      return "cancelled";
    }

    if (
      matches &&
      isLaterTurn &&
      decision === "confirm" &&
      pending.expiresAt > now
    ) {
      this.pendingProfileUpdates.delete(input.sessionId);
      return "confirmed";
    }

    this.pendingProfileUpdates.set(input.sessionId, {
      draftHash: input.draftHash,
      expiresAt: now + (this.options.confirmationTtlMs ?? 10 * 60 * 1000),
      orgId: input.orgId,
      profileId: input.profileId,
      proposedAtTurn: turnIndex,
      userId: input.userId,
    });
    return "needs_confirmation";
  }

  consumeProfileCreateConfirmation(
    sessionId: string | undefined,
    name: string
  ): boolean {
    if (!sessionId) {
      return true;
    }

    const pending = this.pendingProfileNames.get(sessionId);
    if (pending?.has(name)) {
      pending.delete(name);
      return true;
    }

    const next = pending ?? new Set<string>();
    next.add(name);
    this.pendingProfileNames.set(sessionId, next);
    return false;
  }

  private turnFor(sessionId: string): TurnState {
    let turn = this.turns.get(sessionId);

    if (!turn) {
      turn = {
        assignedToolIds: new Set(),
        createdToolIds: new Set(),
        profileUpdateDecision: "unknown",
        turnIndex: 0,
      };
      this.turns.set(sessionId, turn);
    }

    return turn;
  }
}

const PROFILE_UPDATE_CONFIRMATION_PHRASES = new Set([
  "approve",
  "approve it",
  "confirm",
  "confirm it",
  "confirm these changes",
  "go ahead",
  "iya",
  "iya lanjutkan",
  "konfirmasi",
  "lanjutkan",
  "proceed",
  "setuju",
  "ya",
  "ya lanjutkan",
  "yes",
  "yes please",
  "yes please proceed",
]);

const PROFILE_UPDATE_DENIAL_PATTERN =
  /\b(?:batal|batalkan|cancel|deny|do not|don't|jangan|no|reject|stop|tolak)\b/i;

function profileUpdateDecision(
  userMessage: string
): "confirm" | "deny" | "unknown" {
  const normalized = userMessage
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "unknown";
  }
  if (PROFILE_UPDATE_DENIAL_PATTERN.test(normalized)) {
    return "deny";
  }
  return PROFILE_UPDATE_CONFIRMATION_PHRASES.has(normalized)
    ? "confirm"
    : "unknown";
}

export const TOOL_ASSIGNMENT_CONFIRMATION_MESSAGE =
  "This tool was already assigned to a profile in this turn. Assign it to another profile on a later message or from the dashboard.";

export const PROFILE_CREATE_CONFIRMATION_MESSAGE =
  "Draft this profile for the user first. Call create_profile again after they explicitly confirm the name.";

export const PROFILE_UPDATE_CONFIRMATION_MESSAGE =
  "Draft the exact profile changes for the user first. Call update_profile with the unchanged draft in a later turn after they explicitly confirm it.";

export const PROFILE_UPDATE_CANCELLED_MESSAGE =
  "The pending profile update was cancelled and no changes were applied.";
