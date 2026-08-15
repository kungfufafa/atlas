export interface ApprovalGrant {
  actionHash: string;
  approvedAt: string;
  consumedAt?: string;
  executionId: string;
  expiresAt: string;
  id: string;
  orgId: string;
  sessionId: string;
  userId: string;
}

export class ApprovalGrantStore {
  private grants = new Map<string, ApprovalGrant>();

  /**
   * Issue a newly approved grant bound to a specific user, org, session, execution, and action hash.
   */
  createGrant(params: {
    actionHash: string;
    executionId: string;
    expiresInMs?: number;
    id?: string;
    orgId: string;
    sessionId: string;
    userId: string;
  }): ApprovalGrant {
    const id =
      params.id ||
      `grant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const approvedAt = new Date().toISOString();
    const expiresInMs = params.expiresInMs ?? 15 * 60 * 1000; // 15 minutes default
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

    const grant: ApprovalGrant = {
      actionHash: params.actionHash,
      approvedAt,
      executionId: params.executionId,
      expiresAt,
      id,
      orgId: params.orgId,
      sessionId: params.sessionId,
      userId: params.userId,
    };

    this.grants.set(id, grant);
    return grant;
  }

  /**
   * Retrieve a grant by ID.
   */
  getGrant(grantId: string): ApprovalGrant | undefined {
    return this.grants.get(grantId);
  }

  /**
   * Verify and atomically consume an approval grant.
   * Enforces:
   * 1. Grant existence
   * 2. Single-use (not already consumed)
   * 3. Unexpired
   * 4. Strict User and Org multi-tenant boundary
   * 5. Cryptographic Action Hash match (prevents parameter tampering)
   */
  verifyAndConsume(
    grantId: string,
    context: {
      actionHash: string;
      orgId: string;
      sessionId?: string;
      userId: string;
    }
  ): { error?: string; valid: boolean } {
    const grant = this.grants.get(grantId);

    if (!grant) {
      return {
        error: "Approval grant not found or invalid.",
        valid: false,
      };
    }

    // Single-use check (prevent replay attacks)
    if (grant.consumedAt) {
      return {
        error: "Approval grant has already been consumed (replay blocked).",
        valid: false,
      };
    }

    // Expiration check
    if (new Date(grant.expiresAt).getTime() < Date.now()) {
      return {
        error: "Approval grant has expired.",
        valid: false,
      };
    }

    // Multi-tenant Org isolation
    if (grant.orgId !== context.orgId) {
      return {
        error: "Cross-tenant approval grant access forbidden.",
        valid: false,
      };
    }

    // User isolation
    if (grant.userId !== context.userId) {
      return {
        error: "Approval grant belongs to a different user.",
        valid: false,
      };
    }

    // Action Hash match (tampering defense)
    if (grant.actionHash !== context.actionHash) {
      return {
        error:
          "Action parameters do not match the approved grant (tampering blocked).",
        valid: false,
      };
    }

    // Atomically consume
    grant.consumedAt = new Date().toISOString();
    this.grants.set(grantId, grant);

    return { valid: true };
  }

  clear(): void {
    this.grants.clear();
  }
}

export const globalApprovalGrantStore = new ApprovalGrantStore();
