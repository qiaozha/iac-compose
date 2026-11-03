import { deployHostedAgentService } from "../../runtime/services/hosted-agent.js";
import { setAppConfigurationKeyValues } from "../../runtime/services/app-configuration.js";
import { resolve } from "node:path";

import {
  type Deployment,
} from "iac-composer";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  generatedAgentLayer,
  generatedRoot,
  packageRoot,
} from "../../runtime/paths.js";

export async function agent(deployment: Deployment): Promise<void> {
  const solutionLocation = requiredEnv("AZURE_LOCATION");
  const infrastructureLocation = process.env.AZURE_AI_LOCATION?.trim() || "eastus";
  const result = await deployHostedAgentService(deployment, {
    service: "agent",
    directory: generatedRoot,
    sourceDirectory: resolve(packageRoot, "components/agent"),
    provision: {
      layer: generatedAgentLayer,
      deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-agent`,
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: infrastructureLocation,
      parameters: { location: infrastructureLocation },
    },
    configuration: () => ({
      name: deploymentValue(deployment, "agentName"),
      language: "python",
      startupCommand: "python3 -u init.py",
      container: { cpu: "0.5", memory: "1Gi" },
      protocols: [{ protocol: "responses", version: "2.0.0" }],
      docker: { registry: "${AZURE_CONTAINER_REGISTRY_ENDPOINT}", remoteBuild: true },
      deploymentValues: {
        AZURE_CONTAINER_REGISTRY_ENDPOINT: process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
        AZURE_AI_PROJECT_ID: process.env.AZURE_AI_PROJECT_ID,
        FOUNDRY_PROJECT_ENDPOINT: process.env.FOUNDRY_PROJECT_ENDPOINT,
      },
      environment: {
      "AZURE_APPCONFIG_ENDPOINT": deploymentValue(deployment, "appConfigurationEndpoint"),
      },
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
    }),
  });
  const outputs: Record<string, string> = result.status === "deployed" ? {
    ...result.infrastructureOutputs,
    ...result.deploymentOutputs,
    agentEndpoint: result.endpoint,
    agentIdentityPrincipalId: result.principalId,
    agentName: result.agent.name,
    agentVersion: result.agent.version,
  } : {};
  const persistedDeploymentOutputs = { ...outputs };
  delete persistedDeploymentOutputs.AZURE_LOCATION;
  process.env.AZURE_LOCATION = solutionLocation;
  await deployment.deploy("persist agent deployment outputs", async () => {
    await persistEnvironment(
      deployment,
      persistedDeploymentOutputs,
    );
  });
  await deployment.deploy("update agent application configuration", async () => {
    await setAppConfigurationKeyValues(deployment, {
      subscriptionId: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      storeName: requiredEnv("DEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME"),
      values: {
        AI_FOUNDRY_AGENT_NAME: requiredEnv("agentName"),
        AI_FOUNDRY_AGENT_VERSION: requiredEnv("agentVersion"),
      },
    });
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "${" + name + "}" : requiredEnv(name);
}
