import { resolve } from "node:path";

import {
  deployAppServiceContainer,
  prepareAppServiceContainer,
  type Deployment,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  generatedBackendProject,
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
      deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-backend`,
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: requiredEnv("AZURE_LOCATION"),
    },
  );
  await deployment.deploy("persist backend infrastructure", async () => {
    await persistEnvironment(
      requiredEnv("AZURE_ENV_NAME"),
      infrastructureOutputs,
    );
  });

  const service = {
    directory: generatedBackendProject,
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
  });

  await deployment.deploy("persist backend deployment outputs", async () => {
    await persistEnvironment(requiredEnv("AZURE_ENV_NAME"), outputs);
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "${" + name + "}" : requiredEnv(name);
}
