import {
  asRecord,
  componentPathImports,
  componentProvisioningOptions,
  escapeTemplateLiteral,
  implementationOutputName,
  renderRuntimeValue,
  requiredString,
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
  const containerConfiguration = asRecord(container.configuration);
  const runtimeSettings = asRecord(containerConfiguration.runtimeSettings);
  if (
    containerConfiguration.hostedAgent !== undefined &&
    (typeof containerConfiguration.hostedAgent !== "object" ||
      containerConfiguration.hostedAgent === null ||
      Array.isArray(containerConfiguration.hostedAgent))
  ) {
    throw new Error(`${container.id}.configuration.hostedAgent must be an object.`);
  }
  const hosted = asRecord(containerConfiguration.hostedAgent);
  const language = hosted.language === undefined
    ? "python"
    : requiredString(hosted.language, `${container.id}.configuration.hostedAgent.language`);
  const startupCommand = hosted.startupCommand === undefined
    ? language === "python" ? "python3 -u init.py" : undefined
    : requiredString(hosted.startupCommand, `${container.id}.configuration.hostedAgent.startupCommand`);
  const cpu = hosted.cpu === undefined ? "0.5"
    : requiredString(hosted.cpu, `${container.id}.configuration.hostedAgent.cpu`);
  const memory = hosted.memory === undefined ? "1Gi"
    : requiredString(hosted.memory, `${container.id}.configuration.hostedAgent.memory`);
  const protocols = hosted.protocols === undefined
    ? [{ protocol: "responses", version: "2.0.0" }]
    : Array.isArray(hosted.protocols) && hosted.protocols.length > 0
      ? hosted.protocols.map((value, index) => {
          const entry = asRecord(value);
          const path = `${container.id}.configuration.hostedAgent.protocols[${index}]`;
          return {
            protocol: requiredString(entry.protocol, `${path}.protocol`),
            version: requiredString(entry.version, `${path}.version`),
          };
        })
      : undefined;
  if (!protocols) {
    throw new Error(`${container.id}.configuration.hostedAgent.protocols must be a non-empty array.`);
  }
  if (
    hosted.docker !== undefined &&
    (typeof hosted.docker !== "object" || hosted.docker === null || Array.isArray(hosted.docker))
  ) {
    throw new Error(`${container.id}.configuration.hostedAgent.docker must be an object.`);
  }
  const docker = asRecord(hosted.docker);
  if (docker.remoteBuild !== undefined && typeof docker.remoteBuild !== "boolean") {
    throw new Error(`${container.id}.configuration.hostedAgent.docker.remoteBuild must be a boolean.`);
  }
  const dockerValues: Record<string, string | boolean> = {
    registry: docker.registry === undefined ? "${AZURE_CONTAINER_REGISTRY_ENDPOINT}"
      : requiredString(docker.registry, `${container.id}.configuration.hostedAgent.docker.registry`),
    remoteBuild: docker.remoteBuild ?? true,
  };
  for (const field of ["path", "context", "image", "tag"]) {
    if (docker[field] !== undefined) {
      dockerValues[field] = requiredString(
        docker[field],
        `${container.id}.configuration.hostedAgent.docker.${field}`,
      );
    }
  }
  const dockerSource = Object.entries(dockerValues)
    .map(([field, value]) => `        ${field}: ${renderRuntimeValue(value)},`)
    .join("\n");
  const environment = Object.entries(runtimeSettings)
    .map(
      ([name, value]) =>
        `        ${JSON.stringify(name)}: ${renderRuntimeValue(value)},`,
    )
    .join("\n");
  const principalOutputs = new Set(container.produces ?? []);
  const access = resources.flatMap((resource) =>
    accessRecords(resource)
      .filter((grant) => principalOutputs.has(grant.principalOutput))
      .map(
        (grant) => `          {
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
 return `import { resolve } from "node:path";

import type { Deployment } from "iac-composer";
import { deployHostedAgentService } from "../../runtime/services/hosted-agent.js";
${configuration ? 'import { setAppConfigurationKeyValues } from "../../runtime/services/app-configuration.js";\n' : ""}import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
${pathImports}
} from "../../runtime/paths.js";

export async function ${functionName}(deployment: Deployment): Promise<void> {
${ownsModelDeployment ? `  const solutionLocation = requiredEnv("AZURE_LOCATION");
  const infrastructureLocation = process.env.AZURE_AI_LOCATION?.trim() || "eastus";
` : ""}  const result = await deployHostedAgentService(deployment, {
    service: ${JSON.stringify(component)},
    directory: generatedRoot,
    sourceDirectory: resolve(packageRoot, ${JSON.stringify(container.source ?? source ?? ".")}),
${hasProvisioning ? `    provision: ${componentProvisioningOptions(component, resources)},\n` : ""}    configuration: () => ({
      name: deploymentValue(deployment, "agentName"),
      language: ${JSON.stringify(language)},
${startupCommand ? `      startupCommand: ${JSON.stringify(startupCommand)},\n` : ""}      container: { cpu: ${JSON.stringify(cpu)}, memory: ${JSON.stringify(memory)} },
      protocols: ${JSON.stringify(protocols)},
      docker: {
${dockerSource}
      },
      deploymentValues: {
        AZURE_CONTAINER_REGISTRY_ENDPOINT: process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
        AZURE_AI_PROJECT_ID: process.env.AZURE_AI_PROJECT_ID,
        FOUNDRY_PROJECT_ENDPOINT: process.env.FOUNDRY_PROJECT_ENDPOINT,
      },
      environment: {
${environment}
      },
      access: deployment.dryRun ? [] : [
${access.join("\n")}
      ],
    }),
  });
  const outputs: Record<string, string> = result.status === "deployed" ? {
    ...result.infrastructureOutputs,
    ...result.deploymentOutputs,
    ${JSON.stringify(endpointOutput)}: result.endpoint,
    ${JSON.stringify(principalOutput)}: result.principalId,
    agentName: result.agent.name,
    agentVersion: result.agent.version,
  } : {};
${ownsModelDeployment ? `  const persistedDeploymentOutputs = { ...outputs };
  delete persistedDeploymentOutputs.AZURE_LOCATION;
  process.env.AZURE_LOCATION = solutionLocation;
` : ""}  await deployment.deploy("persist ${escapeTemplateLiteral(component)} deployment outputs", async () => {
    await persistEnvironment(
      deployment,
      ${ownsModelDeployment ? "persistedDeploymentOutputs" : "outputs"},
    );
  });
${configuration ? `  await deployment.deploy("update ${escapeTemplateLiteral(component)} application configuration", async () => {
    await setAppConfigurationKeyValues(deployment, {
      subscriptionId: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      storeName: requiredEnv(${JSON.stringify(implementationOutputName(configuration.id, "NAME"))}),
      values: {
        AI_FOUNDRY_AGENT_NAME: requiredEnv("agentName"),
        AI_FOUNDRY_AGENT_VERSION: requiredEnv("agentVersion"),
      },
    });
  });
` : ""}
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