import { resolve } from "node:path";

import {
  deployHostedAgentService,
  type Deployment,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  generatedAgentProject,
  generatedRoot,
  agentProvisioningEntrypoint,
  packageRoot,
} from "../../runtime/paths.js";

export async function agent(deployment: Deployment): Promise<void> {
  const solutionLocation = requiredEnv("AZURE_LOCATION");
  const infrastructureLocation = process.env.AZURE_AI_LOCATION?.trim() || "eastus";
  const infrastructureOutputs = await deployment.provision(
    "agent infrastructure",
    {
      entrypoint: agentProvisioningEntrypoint,
      outputDirectory: generatedAgentProject,
      azdProjectDirectory: generatedRoot,
      layer: "agent",
      dependsOn: ["shared"],
      deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-agent`,
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: infrastructureLocation,
      parameters: { location: infrastructureLocation },
    },
  );
  const persistedInfrastructureOutputs = { ...infrastructureOutputs };
  delete persistedInfrastructureOutputs.AZURE_LOCATION;
  await deployment.deploy("persist agent infrastructure", async () => {
    await persistEnvironment(
      deployment,
      persistedInfrastructureOutputs,
    );
  });

  const outputs = await deployHostedAgentService(deployment, {
    component: "agent",
    generatedDirectory: generatedRoot,
    sourceDirectory: resolve(packageRoot, "components/agent"),
    name: deploymentValue(deployment, "agentName"),
    environment: {
      "AZURE_APPCONFIG_ENDPOINT": deploymentValue(deployment, "appConfigurationEndpoint"),
    },
    endpointOutput: "agentEndpoint",
    principalIdOutput: "agentIdentityPrincipalId",
    access: deployment.dryRun
      ? []
      : [
      {
          role: "Foundry User",
          scope: deploymentValue(
            deployment,
            "DEPLOY_RESOURCE_FOUNDRYPROJECT_ACCESS_SCOPE",
          ),
        },
      {
          role: "App Configuration Data Reader",
          scope: deploymentValue(
            deployment,
            "DEPLOY_RESOURCE_RUNTIMECONFIGURATION_ACCESS_SCOPE",
          ),
        },
      {
          role: "AcrPull",
          scope: deploymentValue(
            deployment,
            "DEPLOY_RESOURCE_CONTAINERREGISTRY_ACCESS_SCOPE",
          ),
        },
      ],
    configurationStoreName: deployment.dryRun
      ? undefined
      : requiredEnv("DEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME"),

  });
  const persistedDeploymentOutputs = { ...outputs };
  delete persistedDeploymentOutputs.AZURE_LOCATION;
  process.env.AZURE_LOCATION = solutionLocation;
  await deployment.deploy("persist agent deployment outputs", async () => {
    await persistEnvironment(
      deployment,
      persistedDeploymentOutputs,
    );
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "${" + name + "}" : requiredEnv(name);
}
