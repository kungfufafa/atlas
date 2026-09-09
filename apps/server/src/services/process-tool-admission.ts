import {
  createRestrictedProcessPreparer,
  type PreparedRestrictedProcess,
  type RestrictedProcess,
  type RestrictedProcessAdmissionPolicy,
  type RestrictedProcessOptions,
} from "./restricted-process";

/** Host-only configuration for the existing Bash/Python sandbox policy. */
export type ProcessToolAdmissionPolicy = Pick<
  RestrictedProcessAdmissionPolicy,
  "authorize" | "requireAdmission"
>;

export type ProcessToolPreparer = (
  options: RestrictedProcessOptions
) => Promise<RestrictedProcess | PreparedRestrictedProcess>;

export function createProcessToolPreparer(
  policy: ProcessToolAdmissionPolicy
): ProcessToolPreparer {
  return createRestrictedProcessPreparer({
    authorize: policy.authorize,
    launchPolicy: "standard",
    requireAdmission: policy.requireAdmission,
  });
}
