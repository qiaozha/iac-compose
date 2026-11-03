import { requireApiConnectionAuthorization } from "./api-connections.js";
import type { Deployment } from "iac-composer";
import {
  requiredProcessValue,
} from "./values.js";

export interface WorkflowDeploymentOptions {
  component: string;
  workflowId: string;
  workflowName: string;
  validationValues?: unknown;
  connectionName?: string;
  authorizationTenantId?: string;
}

export async function enableWorkflowDeployment(
  deployment: Deployment,
  options: WorkflowDeploymentOptions,
): Promise<void> {
  await deployment.deploy(`${options.component} workflow '${options.workflowId}'`, async () => {
    validateWorkflowParameters(options.workflowId, options.validationValues);
    if (options.connectionName) {
      await requireApiConnectionAuthorization(deployment, {
        subscriptionId: requiredProcessValue("AZURE_SUBSCRIPTION_ID"),
        resourceGroup: requiredProcessValue("AZURE_RESOURCE_GROUP"),
        name: options.connectionName,
        portalTenantId: process.env.AZURE_TENANT_ID,
        authorizationTenantId: options.authorizationTenantId,
      });
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

export function validateWorkflowParameters(
  workflowId: string,
  values: unknown,
): void {
  const placeholder = findPlaceholder(values);
  if (placeholder) {
    throw new Error(
      `Workflow resource '${workflowId}' cannot be enabled while '${placeholder.path}' ` +
        `contains placeholder '${placeholder.value}'.`,
    );
  }
}

function findPlaceholder(
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
      const placeholder = findPlaceholder(value[index], `${path}[${index}]`);
      if (placeholder) return placeholder;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [name, child] of Object.entries(value)) {
      const placeholder = findPlaceholder(child, `${path}.${name}`);
      if (placeholder) return placeholder;
    }
  }
  return undefined;
}