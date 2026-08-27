import { resolve } from "node:path";

import {
  deployAppServiceContainer,
  ensureAppServiceIngress,
  prepareAppServiceContainer,
  type Deployment,
  waitForAppServiceReady,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  generatedBackendProject,
  generatedRoot,
  backendProvisioningEntrypoint,
  packageRoot,
} from "../../runtime/paths.js";

export async function backend(deployment: Deployment): Promise<void> {
  const outputs: Record<string, string> = {};
  const infrastructureOutputs = await deployment.provision(
    "backend infrastructure",
    {
      entrypoint: backendProvisioningEntrypoint,
      outputDirectory: generatedBackendProject,
      azdProjectDirectory: generatedRoot,
      layer: "backend",
      dependsOn: ["shared"],
      deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-backend`,
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: requiredEnv("AZURE_LOCATION"),
    },
  );
  await deployment.deploy("persist backend infrastructure", async () => {
    await persistEnvironment(
      deployment,
      infrastructureOutputs,
    );
  });

  await deployment.deploy("configure backend ingress", async () => {
    await ensureAppServiceIngress(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      siteName: requiredEnv("DEPLOY_RESOURCE_BACKENDCOMPUTE_NAME"),
      serviceTags: ["LogicApps"],
      defaultAction: "Deny",
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
  const service = {
    directory: generatedRoot,
    service: "backend",
    ...(deployment.dryRun
      ? {}
      : { resourceName: requiredEnv("DEPLOY_RESOURCE_BACKENDCOMPUTE_NAME") }),
    project: resolve(packageRoot, "components/backend"),
    dockerfile: "Dockerfile",
    context: ".",
    imageName: "backend",
    remoteBuild: true,
    environment: {
      "AZURE_APPCONFIG_ENDPOINT": deploymentValue(deployment, "appConfigurationEndpoint"),
    },
  } as const;
  if (deployment.dryRun) await prepareAppServiceContainer(deployment, service);
  await deployment.deploy("backend container 'backendCompute'", async () => {
    Object.assign(outputs, await deployAppServiceContainer(deployment, service));
    await waitForAppServiceReady(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      siteName: requiredEnv("DEPLOY_RESOURCE_BACKENDCOMPUTE_NAME"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });

  await deployment.deploy("persist backend deployment outputs", async () => {
    await persistEnvironment(deployment, outputs);
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "${" + name + "}" : requiredEnv(name);
}
