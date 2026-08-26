import {
  type CanonicalPrincipal,
  DEFAULT_LEASE_HEARTBEAT_MS,
  ExecutionLeaseError,
  formatAutomationRunError,
  isWorkerSchedulable,
  nanoid,
  PrincipalRequiredError,
  runAsPrincipal,
  type StoredAutomation,
} from "@atlas/core";
import type { AgentService } from "./agent-service";
import type { AutomationDeliveryService } from "./automation-delivery-service";
import type { AutomationService } from "./automation-service";
import type { ExecutionPlaneService } from "./execution-plane-service";
import type { IdentityService } from "./identity-service";

const ORGANIZATION_UNAVAILABLE_ERROR =
  "Automation organization is unavailable.";

export interface AutomationRunOptions {
  fireId?: string;
  principal?: CanonicalPrincipal;
}

export class AutomationRunner {
  constructor(
    private readonly automationService: AutomationService,
    private readonly agentService: AgentService,
    private readonly deliveryService?: AutomationDeliveryService,
    private readonly executionPlane?: ExecutionPlaneService,
    private readonly identityService?: IdentityService
  ) {}

  async run(
    automationId: string,
    options: AutomationRunOptions = {}
  ): Promise<{ output?: string; error?: string; skipped?: boolean }> {
    const automation = await this.automationService.get(automationId);

    if (!automation) {
      throw new Error("Automation not found.");
    }

    if (!automation.enabled) {
      return { error: "Automation is disabled.", skipped: true };
    }

    const orgId = automation.orgId?.trim();
    if (!orgId) {
      throw new Error("Automation organization is missing.");
    }

    if (!(await this.automationService.isOrganizationActive(orgId))) {
      return { error: ORGANIZATION_UNAVAILABLE_ERROR, skipped: true };
    }

    if (!this.executionPlane) {
      return {
        error: "Execution plane is required to claim an automation run.",
        skipped: true,
      };
    }

    let principal: CanonicalPrincipal;
    try {
      principal = await this.resolvePrincipal(automation, options.principal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message, skipped: true };
    }

    const claimed = await this.executionPlane.startAutomationRun({
      automationId,
      fireId: options.fireId?.trim() || nanoid(),
      principal,
    });

    if (claimed.skipped || !claimed.run) {
      return {
        error: claimed.error ?? "Automation is already running.",
        skipped: true,
      };
    }

    const leaseOwner = claimed.run.leaseOwner ?? "";
    let run: Awaited<ReturnType<AutomationService["createRun"]>>;
    try {
      run = await this.automationService.createRun(automationId);
    } catch (error) {
      await this.executionPlane.releaseClaim(claimed.run.id, leaseOwner);
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }

    if (automation.trigger.type === "runAt") {
      await this.automationService.update(automationId, orgId, {
        enabled: false,
      });
    }

    if (!(await this.automationService.isOrganizationActive(orgId))) {
      await this.executionPlane.complete(
        claimed.run.id,
        "cancelled",
        leaseOwner
      );
      await this.automationService.completeRun(run.id, automationId, {
        error: ORGANIZATION_UNAVAILABLE_ERROR,
      });
      return { error: ORGANIZATION_UNAVAILABLE_ERROR, skipped: true };
    }

    const heartbeat = setInterval(() => {
      void this.executionPlane
        ?.heartbeat(claimed.run!.id, leaseOwner)
        .catch(() => {});
    }, DEFAULT_LEASE_HEARTBEAT_MS);

    try {
      const output = await runAsPrincipal(principal, (actor) =>
        this.agentService.runAutomationPrompt(
          orgId,
          automation.profileId,
          automation.prompt,
          automationId,
          run.id,
          actor
        )
      );

      await this.executionPlane.complete(
        claimed.run.id,
        "completed",
        leaseOwner
      );
      const completedRun = await this.automationService.completeRun(
        run.id,
        automationId,
        { output }
      );
      await this.tryDeliver(automation, completedRun);
      return { output };
    } catch (error) {
      if (error instanceof ExecutionLeaseError) {
        return { error: error.message, skipped: true };
      }
      const message = formatAutomationRunError(error);
      try {
        await this.executionPlane.complete(
          claimed.run.id,
          "failed",
          leaseOwner
        );
      } catch (completeError) {
        if (completeError instanceof ExecutionLeaseError) {
          return { error: completeError.message, skipped: true };
        }
        throw completeError;
      }
      const completedRun = await this.automationService.completeRun(
        run.id,
        automationId,
        {
          error: message,
        }
      );
      await this.tryDeliver(automation, completedRun);
      return { error: message };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async resolvePrincipal(
    automation: StoredAutomation,
    explicit?: CanonicalPrincipal
  ): Promise<CanonicalPrincipal> {
    if (explicit) {
      const orgId = automation.orgId?.trim();
      if (orgId && explicit.orgId !== orgId) {
        throw new PrincipalRequiredError(
          "Automation principal must belong to the automation workspace."
        );
      }
      if (this.identityService) {
        return this.rejectViewer(
          await this.identityService.resolveForUser(
            explicit.orgId,
            explicit.userId
          )
        );
      }
      return this.rejectViewer(explicit);
    }

    const ownerId = automation.createdByUserId?.trim();
    const orgId = automation.orgId?.trim();
    if (!(ownerId && orgId)) {
      throw new PrincipalRequiredError(
        "Canonical principal is required to run an automation."
      );
    }
    if (!this.identityService) {
      throw new PrincipalRequiredError(
        "Canonical principal is required to run an automation."
      );
    }
    return this.rejectViewer(
      await this.identityService.resolveForUser(orgId, ownerId)
    );
  }

  private rejectViewer(principal: CanonicalPrincipal): CanonicalPrincipal {
    if (principal.orgRole === "viewer") {
      throw new PrincipalRequiredError("Viewers cannot run automations.");
    }
    return principal;
  }

  private async tryDeliver(
    automation: StoredAutomation,
    run: Awaited<ReturnType<AutomationService["completeRun"]>>
  ): Promise<void> {
    if (!(this.deliveryService && automation.delivery)) {
      return;
    }

    try {
      await this.deliveryService.deliver(automation, run);
    } catch (error) {
      console.error("Automation delivery failed:", error);
    }
  }

  async isRunning(automationId: string): Promise<boolean> {
    if (!this.executionPlane) {
      return false;
    }
    const active = await this.executionPlane.listActiveRuns({
      kind: "automation",
      sessionId: automationId,
    });
    return active.length > 0;
  }

  async getActiveRunCount(): Promise<number> {
    if (!this.executionPlane) {
      return 0;
    }
    const active = await this.executionPlane.listActiveRuns({
      kind: "automation",
    });
    return active.length;
  }

  async getActiveAutomationIds(): Promise<string[]> {
    if (!this.executionPlane) {
      return [];
    }
    const active = await this.executionPlane.listActiveRuns({
      kind: "automation",
    });
    return [
      ...new Set(
        active
          .map((run) => run.sessionId)
          .filter((sessionId): sessionId is string => Boolean(sessionId))
      ),
    ];
  }
}

export function shouldSchedule(automation: StoredAutomation): boolean {
  return isWorkerSchedulable(automation);
}
