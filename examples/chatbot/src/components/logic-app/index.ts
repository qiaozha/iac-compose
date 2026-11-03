import {
  getApiConnectionStatus,
  requireApiConnectionAuthorization,
} from "../../runtime/services/api-connections.js";
import {
  captureAzure,
  type Deployment,
  waitForHttp,
} from "iac-composer";
import {
  optionalEnv,
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  generatedLogicAppLayer,
} from "../../runtime/paths.js";
import { loadLogicAppTeamsConfig } from "./config.js";

export async function prepareLogicAppProvisioning(
  deployment: Deployment,
): Promise<string | undefined> {
  const resourceGroup = optionalEnv("AZURE_RESOURCE_GROUP");
  const connectionName = optionalEnv("TEAMS_CONNECTION_NAME");
  if (!resourceGroup || !connectionName) {
    process.env.CREATE_TEAMS_CONNECTION ??= "true";
    return "";
  }
  const status = await getApiConnectionStatus(deployment, {
    subscriptionId: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    resourceGroup,
    name: connectionName,
  });
  process.env.CREATE_TEAMS_CONNECTION = status === "Connected" ? "false" : "true";
  return status;
}

export async function logicApp(deployment: Deployment): Promise<void> {
  const logicAppTeams = await loadLogicAppTeamsConfig(
    requiredEnv("AZURE_ENV_NAME"),
  );
  const teamsGroupId = requiredOption(
    "teamsGroupId",
    logicAppTeams.teamsGroupId,
  );
  const teamsTenantId = requiredOption("tenantId", logicAppTeams.tenantId);
  const teamsChannelIds = logicAppTeams.teamsChannelIds.map((channelId, index) =>
    requiredOption(`teamsChannelIds[${index}]`, channelId),
  );
  if (teamsChannelIds.length === 0) {
    throw new Error("Logic App option 'teamsChannelIds' is empty.");
  }

  await deployment.deploy("prepare Logic App dependencies", async () => {
    const subscription = requiredEnv("AZURE_SUBSCRIPTION_ID");
    const resourceGroup = requiredEnv("AZURE_RESOURCE_GROUP");
    const functionAppName = requiredEnv("FUNCTION_APP_NAME");
    for (const appName of [
      requiredEnv("AGENT_SERVER_SITE_NAME"),
      functionAppName,
      requiredEnv("FRONTEND_SITE_NAME"),
    ]) {
      await ensureLogicAppsAccessRestriction(
        deployment,
        subscription,
        resourceGroup,
        appName,
      );
    }
    const functionState = (
      await captureAzure(deployment, [
        "functionapp",
        "show",
        "--name",
        functionAppName,
        "--resource-group",
        resourceGroup,
        "--query",
        "state",
        "--output",
        "tsv",
      ])
    ).trim();
    if (functionState !== "Running") {
      throw new Error(`Function App '${functionAppName}' is not running.`);
    }
    const functionHostname = (
      await captureAzure(deployment, [
        "functionapp",
        "show",
        "--name",
        functionAppName,
        "--resource-group",
        resourceGroup,
        "--query",
        "defaultHostName",
        "--output",
        "tsv",
      ])
    ).trim();
    await waitForHttp(`https://${functionHostname}/admin/host/status`, {
      attempts: 20,
      delayMs: 15_000,
      acceptedStatuses: [200, 401, 403],
    });
  });
  if (deployment.dryRun) {
    process.env.DEPLOY_LOGIC_APP_WORKFLOW = "true";
    await provisionLogicApp(
      deployment,
      optionalEnv("AZURE_SUBSCRIPTION_ID") ?? "dry-run-subscription",
      optionalEnv("AZURE_RESOURCE_GROUP") ?? "dry-run-resource-group",
      teamsGroupId,
      teamsChannelIds,
    );
    return;
  }

  const subscription = requiredEnv("AZURE_SUBSCRIPTION_ID");
  const resourceGroup = requiredEnv("AZURE_RESOURCE_GROUP");
  const connectionStatus = await prepareLogicAppProvisioning(deployment);
  process.env.DEPLOY_LOGIC_APP_WORKFLOW =
    connectionStatus === "Connected" ? "true" : "false";

  const outputs = await provisionLogicApp(
    deployment,
    subscription,
    resourceGroup,
    teamsGroupId,
    teamsChannelIds,
  );

  await persistEnvironment(deployment, {
    ...outputs,
    SERVICE_LOGIC_APP_NAME: requiredEnv("LOGIC_APP_WORKFLOW_NAME"),
    SERVICE_TEAMS_CONNECTION_NAME: requiredEnv("TEAMS_CONNECTION_NAME"),
  });

  if (connectionStatus !== "Connected") {
    await requireTeamsConnectionConsent(
      deployment,
      subscription,
      resourceGroup,
      requiredEnv("AZURE_TENANT_ID"),
      teamsTenantId,
    );
  }
}

export function logicAppsAccessRestrictionArgs(
  subscription: string,
  resourceGroup: string,
  appName: string,
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
    appName,
    "--rule-name",
    "Allow Logic Apps",
    "--action",
    "Allow",
    "--service-tag",
    "LogicApps",
    "--priority",
    "100",
  ];
}

export function logicAppsAccessRestrictionQueryArgs(
  subscription: string,
  resourceGroup: string,
  appName: string,
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
    appName,
    "--query",
    "ipSecurityRestrictions[?ipAddress=='LogicApps'].name | [0]",
    "--output",
    "tsv",
  ];
}

async function ensureLogicAppsAccessRestriction(
  deployment: Deployment,
  subscription: string,
  resourceGroup: string,
  appName: string,
): Promise<void> {
  const existingRule = (
    await captureAzure(
      deployment,
      logicAppsAccessRestrictionQueryArgs(
        subscription,
        resourceGroup,
        appName,
      ),
    )
  ).trim();
  if (existingRule) return;
  await deployment.execute({
    command: "az",
    args: logicAppsAccessRestrictionArgs(subscription, resourceGroup, appName),
  });
}

function provisionLogicApp(
  deployment: Deployment,
  subscription: string,
  resourceGroup: string,
  teamsGroupId: string,
  teamsChannelIds: readonly string[],
) {
  return deployment.provision("Logic App resources and workflow", {
    layer: generatedLogicAppLayer,
    deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-logic-app`,
    scope: "resourceGroup",
    resourceGroup,
    subscription,
    parameters: {
      teamsGroupId,
      teamsChannelIds: teamsChannelIds.join(","),
    },
  });
}

function requiredOption(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith("REPLACE_WITH_")) {
    throw new Error(`Logic App option '${name}' is not configured.`);
  }
  return normalized;
}

async function requireTeamsConnectionConsent(
  deployment: Deployment,
  subscription: string,
  resourceGroup: string,
  azureTenantId: string,
  teamsTenantId: string,
): Promise<void> {
  const connectionName = requiredEnv("TEAMS_CONNECTION_NAME");
  await requireApiConnectionAuthorization(deployment, {
    subscriptionId: subscription,
    resourceGroup,
    name: connectionName,
    portalTenantId: azureTenantId,
    authorizationTenantId: teamsTenantId,
  });
}
