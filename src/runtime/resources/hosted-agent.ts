import { resolve } from "node:path";

import { ensureRoleAssignment } from "../../azure.js";
import { createAzdProject } from "../../azd.js";
import type { Deployment } from "../../index.js";
import type { ResourceContractRequirement } from "../../shared/contracts/resources/types.js";
import type { DeployResourceComponentOptions } from "./types.js";
import {
  normalizeImageName,
  requiredProcessValue,
  resolveRuntimeSettings,
  resourceOutputName,
} from "./values.js";

interface HostedAgentVersion {
  name: string;
  version: string;
  status: string;
  instance_identity?: { principal_id?: string };
}

export interface HostedAgentAccess {
  role: string;
  scope: string;
}

export interface HostedAgentDeploymentOptions {
  component: string;
  generatedDirectory: string;
  sourceDirectory: string;
  name: string;
  environment: Readonly<Record<string, string>>;
  endpointOutput: string;
  principalIdOutput: string;
  access?: readonly HostedAgentAccess[];
  configurationStoreName?: string;
}

export async function deployHostedAgentService(
  deployment: Deployment,
  options: HostedAgentDeploymentOptions,
): Promise<Record<string, string>> {
  const project = createAzdProject(deployment, {
    directory: options.generatedDirectory,
    mergeManifest: true,
    manifest: createHostedAgentManifest({
      service: options.component,
      sourceDirectory: options.sourceDirectory,
      name: options.name,
      environment: Object.fromEntries(
        Object.keys(options.environment).map((name) => [name, `\${${name}}`]),
      ),
    }),
    values: {
      AZURE_CONTAINER_REGISTRY_ENDPOINT:
        process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
      AZURE_AI_PROJECT_ID: process.env.AZURE_AI_PROJECT_ID,
      FOUNDRY_PROJECT_ENDPOINT: process.env.FOUNDRY_PROJECT_ENDPOINT,
      ...options.environment,
    },
  });
  if (deployment.dryRun) await project.initialize();

  const outputs: Record<string, string> = {};
  await deployment.deploy(`${options.component} hosted Foundry agent`, async () => {
    const azdValues = await project.deploy(options.component);
    const active = parseHostedAgentVersion(
      await project.capture([
        "ai",
        "agent",
        "show",
        options.component,
        "--environment",
        project.environment,
        "--output",
        "json",
        "--no-prompt",
      ]),
    );
    if (active.status !== "active") {
      throw new Error(
        `azd completed hosted agent deployment with status '${active.status}'.`,
      );
    }
    const principalId = active.instance_identity?.principal_id?.trim();
    if (!principalId) {
      throw new Error("Hosted agent version did not return an instance identity.");
    }
    Object.assign(outputs, azdValues, {
      [options.endpointOutput]: hostedAgentEndpoint(
        azdValues,
        options.component,
      ),
      [options.principalIdOutput]: principalId,
      agentName: active.name,
      agentVersion: active.version,
    });
    for (const access of options.access ?? []) {
      await ensureRoleAssignment(deployment, {
        principalId,
        role: access.role,
        scope: access.scope,
      });
    }
    if (options.configurationStoreName) {
      await updateAgentConfigurationStore(
        deployment,
        options.configurationStoreName,
        active.name,
        active.version,
      );
    }
  });
  return outputs;
}

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

interface HostedAgentManifestOptions {
  service: string;
  sourceDirectory: string;
  name: string;
  environment: Readonly<Record<string, string>>;
}

export function createHostedAgentManifest(
  options: HostedAgentManifestOptions,
): Readonly<Record<string, unknown>> {
  return {
    name: `deploy-${options.service}`,
    services: {
      [options.service]: {
        project: ".",
        host: "azure.ai.agent",
        language: "python",
        docker: {
          path: resolve(options.sourceDirectory, "Dockerfile"),
          context: options.sourceDirectory,
          registry: "${AZURE_CONTAINER_REGISTRY_ENDPOINT}",
          image: normalizeImageName(options.service),
          remoteBuild: true,
        },
        kind: "hosted",
        name: options.name,
        protocols: [{ protocol: "responses", version: "2.0.0" }],
        config: { container: { resources: { cpu: "0.5", memory: "1Gi" } } },
        container: { resources: { cpu: "0.5", memory: "1Gi" } },
        startupCommand: "python3 -u init.py",
        env: options.environment,
      },
    },
  };
}

export function parseHostedAgentVersion(output: string): HostedAgentVersion {
  const value: unknown = JSON.parse(output);
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !("status" in value) ||
    typeof value.status !== "string"
  ) {
    throw new Error("azd ai agent show returned an invalid agent version.");
  }
  return value as HostedAgentVersion;
}

function hostedAgentEndpoint(
  values: Readonly<Record<string, string>>,
  service: string,
): string {
  const prefix = service.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  const endpoint =
    values[`${prefix}_AGENT_ENDPOINT`]?.trim() ||
    values.AGENT_AGENT_ENDPOINT?.trim() ||
    values[`${prefix}_ENDPOINT`]?.trim();
  if (!endpoint) {
    throw new Error("azd deploy did not return a hosted agent endpoint.");
  }
  return endpoint;
}

async function updateAgentConfigurationStore(
  deployment: Deployment,
  storeName: string,
  agentName: string,
  agentVersion: string,
): Promise<void> {
  const subscription = requiredProcessValue("AZURE_SUBSCRIPTION_ID");
  for (const [key, value] of [
    ["AI_FOUNDRY_AGENT_NAME", agentName],
    ["AI_FOUNDRY_AGENT_VERSION", agentVersion],
  ] as const) {
    await deployment.execute({
      command: "az",
      args: appConfigurationKeySetArgs(
        subscription,
        storeName,
        key,
        value,
      ),
    });
  }
}

export function appConfigurationKeySetArgs(
  subscription: string,
  storeName: string,
  key: string,
  value: string,
): string[] {
  return [
    "appconfig",
    "kv",
    "set",
    "--subscription",
    subscription,
    "--name",
    storeName,
    "--auth-mode",
    "login",
    "--key",
    key,
    "--value",
    value,
    "--yes",
    "--output",
    "none",
  ];
}