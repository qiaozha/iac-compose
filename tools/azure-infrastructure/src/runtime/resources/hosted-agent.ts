import { resolve } from "node:path";
import type { Deployment } from "iac-composer";
import { setAppConfigurationKeyValues } from "../services/app-configuration.js";
import {
  deployHostedAgentService,
  type HostedAgentAccess,
} from "../services/hosted-agent.js";
import type { ResourceContractRequirement } from "../../shared/contracts/resources/types.js";
import type { DeployResourceComponentOptions } from "./types.js";
import { requiredProcessValue, requiredString, resolveRuntimeSettings, resourceOutputName } from "./values.js";

export async function deployHostedAgentResource(
  deployment: Deployment,
  options: DeployResourceComponentOptions,
  resource: ResourceContractRequirement,
): Promise<Record<string, string>> {
  const source = resource.source ?? options.source;
  if (!source) {
    throw new Error(`Hosted agent resource '${resource.id}' requires a source directory.`);
  }
  const principalOutputs = new Set(resource.produces ?? []);
  const access: HostedAgentAccess[] = [];
  for (const candidate of options.resources) {
    for (const grant of candidate.access ?? []) {
      if (!principalOutputs.has(grant.principalOutput)) continue;
      access.push({
        role: grant.role,
        scope: requiredProcessValue(
          resourceOutputName(candidate.id, "ACCESS_SCOPE"),
        ),
      });
    }
  }
  const configuration = options.resources.find(
    (candidate) => candidate.kind === "configuration-store",
  );
  const endpointOutput =
    resource.produces?.find((output) => /Endpoint$/i.test(output)) ??
    "agentEndpoint";
  const principalIdOutput =
    resource.produces?.find((output) => /IdentityPrincipalId$/i.test(output)) ??
    "agentIdentityPrincipalId";
  const result = await deployHostedAgentService(deployment, {
    service: options.component,
    directory: options.generatedDirectory,
    sourceDirectory: resolve(options.packageDirectory, source),
    configuration: {
      name: process.env.agentName?.trim() || options.component,
      language: "python",
      startupCommand: "python3 -u init.py",
      container: { cpu: "0.5", memory: "1Gi" },
      protocols: [{ protocol: "responses", version: "2.0.0" }],
      docker: { registry: "${AZURE_CONTAINER_REGISTRY_ENDPOINT}" },
      deploymentValues: {
        AZURE_CONTAINER_REGISTRY_ENDPOINT: process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
        AZURE_AI_PROJECT_ID: process.env.AZURE_AI_PROJECT_ID,
        FOUNDRY_PROJECT_ENDPOINT: process.env.FOUNDRY_PROJECT_ENDPOINT,
      },
      environment: resolveRuntimeSettings(resource, deployment.dryRun),
      access,
    },
  });
  const outputs: Record<string, string> = result.status === "deployed" ? {
    ...result.deploymentOutputs,
    [endpointOutput]: result.endpoint,
    [principalIdOutput]: result.principalId,
    agentName: result.agent.name,
    agentVersion: result.agent.version,
  } : {};
  if (configuration) {
    await deployment.deploy(`update ${options.component} application configuration`, async () => {
      await setAppConfigurationKeyValues(deployment, {
        subscriptionId: requiredProcessValue("AZURE_SUBSCRIPTION_ID"),
        storeName: requiredProcessValue(resourceOutputName(configuration.id, "NAME")),
        values: {
          AI_FOUNDRY_AGENT_NAME: requiredString(outputs.agentName, "agentName"),
          AI_FOUNDRY_AGENT_VERSION: requiredString(outputs.agentVersion, "agentVersion"),
        },
      });
    });
  }
  return outputs;
}
