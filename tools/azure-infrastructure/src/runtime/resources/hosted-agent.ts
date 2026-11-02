import { resolve } from "node:path";
import type { Deployment } from "iac-composer";
import { deployHostedAgentService, type HostedAgentAccess } from "../services/hosted-agent.js";
import type { ResourceContractRequirement } from "../../shared/contracts/resources/types.js";
import type { DeployResourceComponentOptions } from "./types.js";
import { requiredProcessValue, resolveRuntimeSettings, resourceOutputName } from "./values.js";

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
  return deployHostedAgentService(deployment, {
    component: options.component,
    generatedDirectory: options.generatedDirectory,
    sourceDirectory: resolve(options.packageDirectory, source),
    name: process.env.agentName?.trim() || options.component,
    environment: resolveRuntimeSettings(resource, deployment.dryRun),
    endpointOutput,
    principalIdOutput,
    access,
    ...(configuration
      ? {
          configurationStoreName: requiredProcessValue(
            resourceOutputName(configuration.id, "NAME"),
          ),
        }
      : {}),
  });
}
