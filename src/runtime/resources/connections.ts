import { captureAzure } from "../../azure.js";
import type { Deployment } from "../../index.js";
import type { ResourceContract } from "../../shared/contracts/resources/types.js";
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
): Promise<string> {
  const status = (
    await captureAzure(deployment, [
      "resource",
      "show",
      "--subscription",
      requiredProcessValue("AZURE_SUBSCRIPTION_ID"),
      "--resource-group",
      requiredProcessValue("AZURE_RESOURCE_GROUP"),
      "--resource-type",
      "Microsoft.Web/connections",
      "--name",
      options.name,
      "--api-version",
      "2016-06-01",
      "--query",
      "properties.statuses[0].status",
      "--output",
      "tsv",
    ]).catch(() => "")
  ).trim();
  process.env[resourceCreateEnvironmentName(options.resourceId)] =
    status === "Connected" ? "false" : "true";
  return status;
}

export async function prepareResourceRequirements(
  deployment: Deployment,
  contract: ResourceContract,
): Promise<void> {
  for (const resource of contract.resources) {
    if (
      resource.kind !== "authorized-api-connection" ||
      resource.authorization !== "interactive"
    ) {
      continue;
    }
    await prepareAuthorizedConnection(deployment, {
      resourceId: resource.id,
      name: "teams",
    });
  }
}