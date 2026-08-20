interface TurnState {
  assignedToolIds: Set<string>;
  createdToolIds: Set<string>;
}

export class SuperAgentSessionState {
  private readonly turns = new Map<string, TurnState>();
  private readonly pendingProfileNames = new Map<string, Set<string>>();

  beginTurn(sessionId: string): void {
    this.turns.set(sessionId, {
      assignedToolIds: new Set(),
      createdToolIds: new Set(),
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
      };
      this.turns.set(sessionId, turn);
    }

    return turn;
  }
}

export const TOOL_ASSIGNMENT_CONFIRMATION_MESSAGE =
  "This tool was already assigned to a profile in this turn. Assign it to another profile on a later message or from the dashboard.";

export const PROFILE_CREATE_CONFIRMATION_MESSAGE =
  "Draft this profile for the user first. Call create_profile again after they explicitly confirm the name.";
