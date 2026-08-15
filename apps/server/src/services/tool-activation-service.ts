export class ToolActivationService {
  private activeToolsBySession = new Map<string, Set<string>>();

  /**
   * Activate tools into a specific session's active toolset.
   */
  activateTools(sessionId: string, toolNames: string[]): string[] {
    if (!sessionId) {
      return [];
    }

    let active = this.activeToolsBySession.get(sessionId);
    if (!active) {
      active = new Set<string>();
      this.activeToolsBySession.set(sessionId, active);
    }

    const newlyActivated: string[] = [];
    for (const name of toolNames) {
      const trimmed = name.trim();
      if (trimmed && !active.has(trimmed)) {
        active.add(trimmed);
        newlyActivated.push(trimmed);
      }
    }

    return newlyActivated;
  }

  /**
   * Get all dynamically activated tool names for a session.
   */
  getActiveTools(sessionId: string): string[] {
    if (!sessionId) {
      return [];
    }
    const active = this.activeToolsBySession.get(sessionId);
    return active ? Array.from(active) : [];
  }

  /**
   * Check if a specific tool has been dynamically activated in a session.
   */
  isToolActive(sessionId: string, toolName: string): boolean {
    if (!sessionId) {
      return false;
    }
    return this.activeToolsBySession.get(sessionId)?.has(toolName) ?? false;
  }

  /**
   * Reset / clear dynamic tools for a session.
   */
  clearSessionTools(sessionId: string): void {
    if (sessionId) {
      this.activeToolsBySession.delete(sessionId);
    }
  }
}

export const toolActivationService = new ToolActivationService();
