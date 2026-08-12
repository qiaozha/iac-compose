import { resolve } from "node:path";

import {
  deployAppServiceContainer,
  ensureAppServiceIngress,
  ensureAppServicePeerIngress,
  prepareAppServiceContainer,
  provisionTeamsApplication,
  type Deployment,
  waitForAppServiceReady,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import { configureEntraApplications } from "../shared/identity.js";
import {
  generatedFrontendProject,
  frontendProvisioningEntrypoint,
  packageRoot,
} from "../../runtime/paths.js";

export async function frontend(deployment: Deployment): Promise<void> {
  const outputs: Record<string, string> = {};
  const infrastructureOutputs = await deployment.provision(
    "frontend infrastructure",
    {
      entrypoint: frontendProvisioningEntrypoint,
      outputDirectory: generatedFrontendProject,
      deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-frontend`,
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: requiredEnv("AZURE_LOCATION"),
    },
  );
  await deployment.deploy("persist frontend infrastructure", async () => {
    await persistEnvironment(
      requiredEnv("AZURE_ENV_NAME"),
      infrastructureOutputs,
    );
  });

  await configureEntraApplications(deployment);
  await deployment.deploy("configure frontend ingress", async () => {
    await ensureAppServiceIngress(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      siteName: requiredEnv("DEPLOY_RESOURCE_FRONTENDCOMPUTE_NAME"),
      serviceTags: ["LogicApps","AzureBotService"],
      defaultAction: "Deny",
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
  await deployment.deploy("configure frontendCompute access to backendCompute", async () => {
    await ensureAppServicePeerIngress(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      sourceSiteName: requiredEnv("DEPLOY_RESOURCE_FRONTENDCOMPUTE_NAME"),
      targetSiteName: requiredEnv("DEPLOY_RESOURCE_BACKENDCOMPUTE_NAME"),
      sourceResourceName: "frontendCompute",
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
  const service = {
    directory: generatedFrontendProject,
    service: "frontend",
    ...(deployment.dryRun
      ? {}
      : { resourceName: requiredEnv("DEPLOY_RESOURCE_FRONTENDCOMPUTE_NAME") }),
    project: resolve(packageRoot, "components/frontend"),
    dockerfile: "Dockerfile",
    context: ".",
    imageName: "frontend",
    remoteBuild: true,
    environment: {
      "BOT_ID": deploymentValue(deployment, "botClientId"),
      "BOT_TENANT_ID": deploymentValue(deployment, "tenantId"),
      "BOT_TYPE": "UserAssignedMSI",
      "BOT_DISPLAY_NAME": "Contoso Support",
      "BACKEND_BASE_URL": deploymentValue(deployment, "backendBaseUrl"),
      "BACKEND_SCOPE": deploymentValue(deployment, "backendAudience"),
      "USER_ASSIGNED_IDENTITY_CLIENT_ID": deploymentValue(deployment, "botClientId"),
    },
  } as const;
  if (deployment.dryRun) await prepareAppServiceContainer(deployment, service);
  await deployment.deploy("frontend container 'frontendCompute'", async () => {
    Object.assign(outputs, await deployAppServiceContainer(deployment, service));
    await waitForAppServiceReady(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      siteName: requiredEnv("DEPLOY_RESOURCE_FRONTENDCOMPUTE_NAME"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
  Object.assign(
    outputs,
    await provisionTeamsApplication(deployment, {
      component: "frontend",
      componentDirectory: resolve(packageRoot, "components/frontend"),
      existingAppId: "9668bcb5-a50b-4e39-a136-b3301305de66",
      manifestValues: {
        "BOT_ID": deploymentValue(deployment, "botClientId"),
        "DEVELOPER_NAME": "Contoso",
        "DEVELOPER_WEBSITE_URL": "https://www.contoso.com",
        "PRIVACY_URL": "https://www.contoso.com/privacy",
        "TERMS_OF_USE_URL": "https://www.contoso.com/terms",
        "TEAMS_BOT_SHORT_DISPLAY_NAME": "Contoso Support",
        "TEAMS_BOT_FULL_DISPLAY_NAME": "Contoso Support Agent",
        "TEAMS_APP_SHORT_DESCRIPTION": "Get help with Contoso products and services.",
        "TEAMS_APP_FULL_DESCRIPTION": "Get answers about Contoso, its products and services, and its documented business and technical environment.",
      },
      outputNames: ["teamsAppId"],
    }),
  );
  await deployment.deploy("persist frontend deployment outputs", async () => {
    await persistEnvironment(requiredEnv("AZURE_ENV_NAME"), outputs);
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "${" + name + "}" : requiredEnv(name);
}
