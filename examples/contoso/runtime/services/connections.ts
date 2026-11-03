import { getApiConnectionStatus } from "./api-connections.js";
import type { Deployment } from "iac-composer";
import {
  requiredProcessValue,
  resourceCreateEnvironmentName,
} from "./values.js";

export interface AuthorizedConnectionOptions {
  resourceId: string;
  name: string;
}

export async function prepareAuthorizedConnection(
  deployment: Deployment,
  options: AuthorizedConnectionOptions,
): Promise<string | undefined> {
  const status = await getApiConnectionStatus(deployment, {
    subscriptionId: requiredProcessValue("AZURE_SUBSCRIPTION_ID"),
    resourceGroup: requiredProcessValue("AZURE_RESOURCE_GROUP"),
    name: options.name,
  });
  process.env[resourceCreateEnvironmentName(options.resourceId)] =
    status === "Connected" ? "false" : "true";
  return status;
}
