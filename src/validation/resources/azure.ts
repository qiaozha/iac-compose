import {
  captureAzure,
  ensureRoleAssignment,
  resolveAzureAccountContext,
} from "../../azure.js";
import type { Deployment } from "../../index.js";
import { planResourceValidation } from "./plan.js";
import type {
  DeploymentRoleValidation,
  EnsureDeploymentPrincipalRolesOptions,
  ResourceProviderValidation,
  ResourceRequirementsValidationResult,
  ValidateResourceRequirementsOptions,
} from "./types.js";

export async function validateResourceRequirements(
  deployment: Deployment,
  options: ValidateResourceRequirementsOptions,
): Promise<ResourceRequirementsValidationResult> {
  if (options.scope && options.resourceGroup) {
    throw new Error("Specify either scope or resourceGroup, not both.");
  }
  const plan = planResourceValidation(options.requirements, options.solution);
  const account = await resolveAzureAccountContext(deployment, {
    subscriptionId: options.subscriptionId,
    tenantId: options.tenantId,
    principalId: options.principalId,
    principalType: options.principalType,
  });
  const scope =
    options.scope?.trim() ||
    (options.resourceGroup?.trim()
      ? `/subscriptions/${account.subscriptionId}/resourceGroups/${options.resourceGroup.trim()}`
      : `/subscriptions/${account.subscriptionId}`);
  const providers: ResourceProviderValidation[] = [];
  for (const namespace of plan.providers) {
    const registrationState = (
      await captureAzure(deployment, [
        "provider",
        "show",
        "--subscription",
        account.subscriptionId,
        "--namespace",
        namespace,
        "--query",
        "registrationState",
        "--output",
        "tsv",
      ])
    ).trim();
    providers.push({ namespace, registrationState });
  }

  const roles: DeploymentRoleValidation[] = [];
  for (const role of plan.roles) {
    let granted = false;
    let present: boolean;
    if (options.grant) {
      granted = await ensureRoleAssignment(deployment, {
        principalId: account.principalId,
        principalType: account.principalType,
        role: role.roleDefinitionId,
        scope,
        includeInherited: true,
      });
      present = true;
    } else {
      present = await hasRoleAssignment(
        deployment,
        account.principalId,
        role.roleDefinitionId,
        scope,
      );
    }
    roles.push({ ...role, present, granted });
  }

  return { ...account, scope, providers, roles };
}

export async function ensureDeploymentPrincipalRoles(
  deployment: Deployment,
  options: EnsureDeploymentPrincipalRolesOptions,
): Promise<void> {
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

async function hasRoleAssignment(
  deployment: Deployment,
  principalId: string,
  roleDefinitionId: string,
  scope: string,
): Promise<boolean> {
  return Boolean(
    (
      await captureAzure(deployment, [
        "role",
        "assignment",
        "list",
        "--assignee",
        principalId,
        "--role",
        roleDefinitionId,
        "--scope",
        scope,
        "--include-inherited",
        "--query",
        "[0].id",
        "--output",
        "tsv",
      ])
    ).trim(),
  );
}