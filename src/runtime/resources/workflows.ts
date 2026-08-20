import { captureAzure } from "../../azure.js";
import type { Deployment } from "../../index.js";
import type { ResourceContractRequirement } from "../../shared/contracts/resources/types.js";
import type { DeployResourceComponentOptions } from "./types.js";
import {
  requiredProcessValue,
  resourceOutputName,
} from "./values.js";

export interface WorkflowDeploymentOptions {
  component: string;
  workflowId: string;
  workflowName: string;
  validationValues?: unknown;
  connectionName?: string;
  authorizationTenantId?: string;
}

export async function enableResourceWorkflow(
  deployment: Deployment,
  options: DeployResourceComponentOptions,
  resource: ResourceContractRequirement,
): Promise<void> {
  const placeholder = findContractPlaceholder(resource.parameters);
  if (placeholder) {
    throw new Error(
      `Workflow resource '${resource.id}' cannot be enabled while '${placeholder.path}' ` +
        `contains placeholder '${placeholder.value}'.`,
    );
  }
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

export async function enableWorkflowDeployment(
  deployment: Deployment,
  options: WorkflowDeploymentOptions,
): Promise<void> {
  await deployment.deploy(`${options.component} workflow '${options.workflowId}'`, async () => {
    const placeholder = findContractPlaceholder(options.validationValues);
    if (placeholder) {
      throw new Error(
        `Workflow resource '${options.workflowId}' cannot be enabled while '${placeholder.path}' ` +
          `contains placeholder '${placeholder.value}'.`,
      );
    }
    if (options.connectionName) {
      await requireAuthorizedConnection(
        deployment,
        options.connectionName,
        options.authorizationTenantId,
      );
    }
    await deployment.execute({
      command: "az",
      args: [
        "resource",
        "update",
        "--subscription",
        requiredProcessValue("AZURE_SUBSCRIPTION_ID"),
        "--resource-group",
        requiredProcessValue("AZURE_RESOURCE_GROUP"),
        "--resource-type",
        "Microsoft.Logic/workflows",
        "--name",
        options.workflowName,
        "--api-version",
        "2019-05-01",
        "--set",
        "properties.state=Enabled",
        "--output",
        "none",
      ],
    });
  });
}

async function requireAuthorizedConnection(
  deployment: Deployment,
  connectionName: string,
  authorizationTenantId?: string,
): Promise<void> {
  const subscription = requiredProcessValue("AZURE_SUBSCRIPTION_ID");
  const resourceGroup = requiredProcessValue("AZURE_RESOURCE_GROUP");
  const status = (
    await captureAzure(deployment, [
      "resource",
      "show",
      "--subscription",
      subscription,
      "--resource-group",
      resourceGroup,
      "--resource-type",
      "Microsoft.Web/connections",
      "--name",
      connectionName,
      "--api-version",
      "2016-06-01",
      "--query",
      "properties.statuses[0].status",
      "--output",
      "tsv",
    ]).catch(() => "")
  ).trim();
  if (status === "Connected") return;
  const tenant = process.env.AZURE_TENANT_ID?.trim() ?? "common";
  const resourceId =
    `/subscriptions/${subscription}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Web/connections/${connectionName}`;
  const authorizationAccount = authorizationTenantId
    ? ` with an account from tenant '${authorizationTenantId}'`
    : "";
  throw new Error(
    `API connection '${connectionName}' requires interactive consent ` +
      `(current status: '${status || "NotConnected"}'). Open ` +
      `https://portal.azure.com/#@${tenant}/resource${resourceId}/edit, ` +
      `authorize the connection${authorizationAccount}, then rerun deploy-js.`,
  );
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

function findContractPlaceholder(
  value: unknown,
  path = "parameters",
): { path: string; value: string } | undefined {
  if (typeof value === "string") {
    return /^<[^>]+>$/.test(value) || value.startsWith("REPLACE_WITH_")
      ? { path, value }
      : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const placeholder = findContractPlaceholder(value[index], `${path}[${index}]`);
      if (placeholder) return placeholder;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [name, child] of Object.entries(value)) {
      const placeholder = findContractPlaceholder(child, `${path}.${name}`);
      if (placeholder) return placeholder;
    }
  }
  return undefined;
}