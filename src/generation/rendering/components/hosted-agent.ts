import {
  asRecord,
  componentPathImports,
  componentProvisioningBlock,
  escapeTemplateLiteral,
  implementationOutputName,
  renderRuntimeValue,
} from "./helpers.js";
import type { ComponentSourceOptions } from "./options.js";
import type { ResourceRequirement } from "../../contracts/deployment.js";

export function renderHostedAgentComponentSource(
  options: ComponentSourceOptions,
): string {
  const {
    component,
    functionName,
    source,
    resources,
    hasProvisioning,
  } = options;
  const ownsModelDeployment = resources.some(
    (resource) => resource.kind === "model-deployment",
  );
  const containers = resources.filter(
    (resource) =>
      resource.kind === "container-host" &&
      resource.requiredBy.includes(component),
  );
  if (containers.length !== 1) {
    throw new Error(
      `Hosted agent '${component}' requires exactly one container-host resource; found ${containers.length}.`,
    );
  }
  const container = containers[0]!;
  const runtimeSettings = asRecord(
    asRecord(container.configuration).runtimeSettings,
  );
  const environment = Object.entries(runtimeSettings)
    .map(
      ([name, value]) =>
        `      ${JSON.stringify(name)}: ${renderRuntimeValue(value)},`,
    )
    .join("\n");
  const principalOutputs = new Set(container.produces ?? []);
  const access = resources.flatMap((resource) =>
    accessRecords(resource)
      .filter((grant) => principalOutputs.has(grant.principalOutput))
      .map(
        (grant) => `      {
          role: ${JSON.stringify(grant.role)},
          scope: deploymentValue(
            deployment,
            ${JSON.stringify(implementationOutputName(resource.id, "ACCESS_SCOPE"))},
          ),
        },`,
      ),
  );
  const configuration = resources.find(
    (resource) => resource.kind === "configuration-store",
  );
  const endpointOutput =
    container.produces?.find((output) => /Endpoint$/i.test(output)) ??
    "agentEndpoint";
  const principalOutput =
    container.produces?.find((output) => /IdentityPrincipalId$/i.test(output)) ??
    "agentIdentityPrincipalId";
  const pathImports = componentPathImports(component, hasProvisioning, true);
  const provisioning = componentProvisioningBlock(
    component,
    hasProvisioning,
    false,
    resources,
  );
  return `import { resolve } from "node:path";

import {
  deployHostedAgentService,
  type Deployment,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
${pathImports}
} from "../../runtime/paths.js";

export async function ${functionName}(deployment: Deployment): Promise<void> {
${provisioning}
  const outputs = await deployHostedAgentService(deployment, {
    component: ${JSON.stringify(component)},
    generatedDirectory: generatedRoot,
    sourceDirectory: resolve(packageRoot, ${JSON.stringify(container.source ?? source ?? ".")}),
    name: deploymentValue(deployment, "agentName"),
    environment: {
${environment}
    },
    endpointOutput: ${JSON.stringify(endpointOutput)},
    principalIdOutput: ${JSON.stringify(principalOutput)},
    access: deployment.dryRun
      ? []
      : [
${access.join("\n")}
      ],
${configuration ? `    configurationStoreName: deployment.dryRun\n      ? undefined\n      : requiredEnv(${JSON.stringify(implementationOutputName(configuration.id, "NAME"))}),\n` : ""}
  });
${ownsModelDeployment ? `  const persistedDeploymentOutputs = { ...outputs };
  delete persistedDeploymentOutputs.AZURE_LOCATION;
  process.env.AZURE_LOCATION = solutionLocation;
` : ""}  await deployment.deploy("persist ${escapeTemplateLiteral(component)} deployment outputs", async () => {
    await persistEnvironment(
      deployment,
      ${ownsModelDeployment ? "persistedDeploymentOutputs" : "outputs"},
    );
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "\${" + name + "}" : requiredEnv(name);
}
`;
}

function accessRecords(resource: ResourceRequirement): Array<{
  principalOutput: string;
  role: string;
}> {
  return Array.isArray(resource.access)
    ? resource.access.map((value, index) => {
        const record = asRecord(value);
        return {
          principalOutput: requiredGeneratedString(
            record.principalOutput,
            `${resource.id}.access[${index}].principalOutput`,
          ),
          role: requiredGeneratedString(
            record.role,
            `${resource.id}.access[${index}].role`,
          ),
        };
      })
    : [];
}

function requiredGeneratedString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}