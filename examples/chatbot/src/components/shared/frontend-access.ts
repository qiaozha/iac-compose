import { captureAzure, type Deployment } from "iac-compose";
import { requiredEnv } from "../../runtime/environment.js";

interface AccessRestriction {
  ipAddress?: string;
  priority?: number;
}

export async function ensureFrontendAccessRestrictions(
  deployment: Deployment,
): Promise<void> {
  const subscription = requiredEnv("AZURE_SUBSCRIPTION_ID");
  const resourceGroup = requiredEnv("AZURE_RESOURCE_GROUP");
  const frontendSiteName = requiredEnv("FRONTEND_SITE_NAME");
  const agentServerSiteName = requiredEnv("AGENT_SERVER_SITE_NAME");
  const outboundAddresses = (
    await captureAzure(
      deployment,
      frontendOutboundIpQueryArgs(
        subscription,
        resourceGroup,
        frontendSiteName,
      ),
    )
  )
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => `${address}/32`);
  const restrictions = JSON.parse(
    await captureAzure(
      deployment,
      frontendAccessRestrictionQueryArgs(
        subscription,
        resourceGroup,
        agentServerSiteName,
      ),
    ),
  ) as AccessRestriction[];
  const allowedAddresses = new Set(
    restrictions.flatMap((restriction) =>
      (restriction.ipAddress ?? "")
        .split(",")
        .map((address) => address.trim()),
    ),
  );
  let priority = Math.max(
    199,
    ...restrictions
      .map((restriction) => restriction.priority ?? 0)
      .filter((value) => value < 2_147_483_647),
  );

  const missingAddresses = outboundAddresses.filter(
    (address) => !allowedAddresses.has(address),
  );
  for (let index = 0; index < missingAddresses.length; index += 8) {
    priority += 1;
    await deployment.execute({
      command: "az",
      args: frontendAccessRestrictionArgs(
        subscription,
        resourceGroup,
        agentServerSiteName,
        missingAddresses.slice(index, index + 8).join(","),
        priority,
      ),
    });
  }
}

export function frontendOutboundIpQueryArgs(
  subscription: string,
  resourceGroup: string,
  frontendSiteName: string,
): string[] {
  return [
    "webapp",
    "show",
    "--subscription",
    subscription,
    "--resource-group",
    resourceGroup,
    "--name",
    frontendSiteName,
    "--query",
    "possibleOutboundIpAddresses",
    "--output",
    "tsv",
  ];
}

export function frontendAccessRestrictionQueryArgs(
  subscription: string,
  resourceGroup: string,
  agentServerSiteName: string,
): string[] {
  return [
    "webapp",
    "config",
    "access-restriction",
    "show",
    "--subscription",
    subscription,
    "--resource-group",
    resourceGroup,
    "--name",
    agentServerSiteName,
    "--query",
    "ipSecurityRestrictions",
    "--output",
    "json",
  ];
}

export function frontendAccessRestrictionArgs(
  subscription: string,
  resourceGroup: string,
  agentServerSiteName: string,
  address: string,
  priority: number,
): string[] {
  return [
    "webapp",
    "config",
    "access-restriction",
    "add",
    "--subscription",
    subscription,
    "--resource-group",
    resourceGroup,
    "--name",
    agentServerSiteName,
    "--rule-name",
    `Allow frontend outbound ${priority}`,
    "--action",
    "Allow",
    "--ip-address",
    address,
    "--priority",
    String(priority),
  ];
}