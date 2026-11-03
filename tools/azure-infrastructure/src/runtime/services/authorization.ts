import {
  ensureRoleAssignment,
  resolveAzureAccountContext,
} from "iac-composer";
import type { Deployment } from "iac-composer";

export {
  ensureRoleAssignment,
  type AzureRoleAssignmentOptions,
} from "iac-composer";

export interface DeploymentRoleRequirement {
  readonly provider: string;
  readonly role: string;
  readonly roleDefinitionId: string;
  readonly reason: string;
}

export interface EnsureDeploymentPrincipalRolesOptions {
  readonly subscriptionId: string;
  readonly tenantId?: string;
  readonly principalId?: string;
  readonly principalType?: string;
  readonly scope: string;
  readonly roles: readonly DeploymentRoleRequirement[];
}

export async function ensureDeploymentPrincipalRoles(
  deployment: Deployment,
  options: EnsureDeploymentPrincipalRolesOptions,
): Promise<void> {
  if (deployment.dryRun) return;
  const account = await resolveAzureAccountContext(deployment, options);
  for (const role of options.roles) {
    await ensureRoleAssignment(deployment, {
      principalId: account.principalId,
      principalType: account.principalType,
      role: role.roleDefinitionId,
      scope: options.scope,
      includeInherited: true,
    });
  }
}
