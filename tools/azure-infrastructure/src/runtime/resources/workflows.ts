import type { Deployment } from "iac-composer";
import { enableWorkflowDeployment, validateWorkflowParameters } from "../services/workflows.js";
import type { ResourceContractRequirement } from "../../shared/contracts/resources/types.js";
import type { DeployResourceComponentOptions } from "./types.js";
import { requiredProcessValue, resourceOutputName } from "./values.js";

export async function enableResourceWorkflow(
  deployment: Deployment,
  options: DeployResourceComponentOptions,
  resource: ResourceContractRequirement,
): Promise<void> {
  validateWorkflowParameters(resource.id, resource.parameters);
  const connection = options.resources.find(
    (candidate) =>
      candidate.kind === "authorized-api-connection" &&
      candidate.authorization === "interactive",
  );
  const authorizationTenantId = connection
    ? connectionAuthorizationTenantId(connection)
    : undefined;
  await enableWorkflowDeployment(deployment, {
    component: options.component,
    workflowId: resource.id,
    workflowName: requiredProcessValue(resourceOutputName(resource.id, "NAME")),
    validationValues: resource.parameters,
    ...(connection
      ? {
          connectionName: requiredProcessValue(
            resourceOutputName(connection.id, "NAME"),
          ),
        }
      : {}),
    ...(authorizationTenantId ? { authorizationTenantId } : {}),
  });
}

function connectionAuthorizationTenantId(
  resource: ResourceContractRequirement,
): string | undefined {
  const value = resource.configuration?.tenantId;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `${resource.id}.configuration.tenantId must be a non-empty string.`,
    );
  }
  return value.trim();
}
