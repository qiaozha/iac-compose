import { captureAzure } from "iac-composer";
import type { Deployment } from "iac-composer";

export interface ApiConnectionOptions {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
}

export interface ApiConnectionAuthorizationOptions extends ApiConnectionOptions {
  portalTenantId?: string;
  authorizationTenantId?: string;
}

export async function getApiConnectionStatus(
  deployment: Deployment,
  options: ApiConnectionOptions,
): Promise<string | undefined> {
  if (deployment.dryRun) return undefined;
  let output: string;
  try {
    output = await captureAzure(deployment, [
      "resource",
      "show",
      "--subscription",
      options.subscriptionId,
      "--resource-group",
      options.resourceGroup,
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
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      /\((?:ResourceNotFound|ResourceGroupNotFound)\)/.test(error.message)
    ) {
      return undefined;
    }
    throw error;
  }
  const status = output.trim();
  if (!status) {
    throw new Error(`API connection '${options.name}' did not return an authorization status.`);
  }
  return status;
}

export async function requireApiConnectionAuthorization(
  deployment: Deployment,
  options: ApiConnectionAuthorizationOptions,
): Promise<void> {
  if (deployment.dryRun) return;
  const status = await getApiConnectionStatus(deployment, options);
  if (status === "Connected") return;
  const resourceId =
    `/subscriptions/${options.subscriptionId}/resourceGroups/${options.resourceGroup}` +
    `/providers/Microsoft.Web/connections/${options.name}`;
  const authorizationAccount = options.authorizationTenantId
    ? ` with an account from tenant '${options.authorizationTenantId}'`
    : "";
  throw new Error(
    `API connection '${options.name}' requires interactive consent ` +
      `(current status: '${status ?? "NotFound"}'). Open ` +
      `https://portal.azure.com/#@${options.portalTenantId ?? "common"}/resource${resourceId}/edit, ` +
      `authorize the connection${authorizationAccount}, then rerun iac-composer.`,
  );
}
