import type { ProvisionedEnvironment } from "./environment-provisioner";
import { isPortAvailable } from "./free-port";

export interface CleanupAuditResult {
  developerEnvironmentUntouched: boolean;
  issues: string[];
  passed: boolean;
  portsReleased: boolean;
}

export class CleanupAuditor {
  async audit(
    env: ProvisionedEnvironment,
    trackedPorts: number[]
  ): Promise<CleanupAuditResult> {
    const issues: string[] = [];

    // Check 1: Developer ~/.atlas preservation
    const devEnvUntouched = env.verifyDeveloperEnvironmentUntouched();
    if (!devEnvUntouched) {
      issues.push(
        "Developer environment (~/.atlas) was modified during the release gate run!"
      );
    }

    // Check 2: Ports released
    let allPortsReleased = true;
    for (const port of trackedPorts) {
      if (port > 0) {
        const available = await isPortAvailable(port);
        if (!available) {
          allPortsReleased = false;
          issues.push(`Port ${port} was not released after teardown!`);
        }
      }
    }

    return {
      developerEnvironmentUntouched: devEnvUntouched,
      issues,
      passed: issues.length === 0,
      portsReleased: allPortsReleased,
    };
  }
}
