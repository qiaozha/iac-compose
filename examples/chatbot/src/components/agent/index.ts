import { resolve } from "node:path";

import {
  createAzdProject,
  ensureRoleAssignment,
  type Deployment,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  agentRoot,
  agentProvisioningEntrypoint,
  generatedAgentProject,
} from "../../runtime/paths.js";
import {
  seedRuntimeConfiguration,
  setAppConfigurationValues,
} from "../shared/configuration.js";
import { configureServerApplication } from "../shared/identity.js";

const agentName = "azure-sdk-chat-agent";

export interface AgentVersion {
  name: string;
  version: string;
  status: string;
  instance_identity?: { principal_id?: string };
}

export async function agent(deployment: Deployment): Promise<void> {
  const outputs = await deployment.provision("Foundry agent infrastructure", {
    entrypoint: agentProvisioningEntrypoint,
    outputDirectory: generatedAgentProject,
    deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-agent`,
    scope: "resourceGroup",
    resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
  });
  if (deployment.dryRun) {
    await configureServerApplication(deployment);
  }
  await deployment.deploy(
    "persist, configure, and seed agent infrastructure",
    async () => {
      await persistEnvironment(requiredEnv("AZURE_ENV_NAME"), outputs);
      await configureServerApplication(deployment);
      await seedRuntimeConfiguration(deployment);
    },
  );

  if (deployment.dryRun) {
    const project = createAzdProject(deployment, {
      directory: generatedAgentProject,
      mergeManifest: true,
      manifest: createAgentAzdManifest({
        dockerfile: resolve(agentRoot, "agents/chat_agent/Dockerfile"),
        context: agentRoot,
      }),
    });
    await project.initialize();
  }

  await deployment.deploy("hosted Foundry agent", async () => {
    const project = createAzdProject(deployment, {
      directory: generatedAgentProject,
      mergeManifest: true,
      manifest: createAgentAzdManifest({
        dockerfile: resolve(agentRoot, "agents/chat_agent/Dockerfile"),
        context: agentRoot,
        tag: process.env.AGENT_IMAGE_TAG?.trim(),
      }),
      values: {
        AZURE_CONTAINER_REGISTRY_ENDPOINT:
          process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
        AZURE_AI_PROJECT_ID: requiredEnv("AZURE_AI_PROJECT_ID"),
        FOUNDRY_PROJECT_ENDPOINT: requiredEnv("FOUNDRY_PROJECT_ENDPOINT"),
        AZURE_APPCONFIG_ENDPOINT: requiredEnv("AZURE_APPCONFIG_ENDPOINT"),
      },
    });
    const values = await project.deploy("agent");
    const active = parseAgentVersion(
      await project.capture([
        "ai",
        "agent",
        "show",
        "agent",
        "--environment",
        project.environment,
        "--output",
        "json",
        "--no-prompt",
      ]),
    );
    if (active.status !== "active") {
      throw new Error(
        `azd completed agent deployment with status '${active.status}'.`,
      );
    }
    const persisted = {
      AGENT_AGENT_NAME: active.name,
      AGENT_AGENT_VERSION: active.version,
      AGENT_AGENT_ENDPOINT: requiredAzdValue(values, "AGENT_AGENT_ENDPOINT"),
      AGENT_AGENT_RESPONSES_ENDPOINT: requiredAzdValue(
        values,
        "AGENT_AGENT_RESPONSES_ENDPOINT",
      ),
    };
    const image = values.SERVICE_AGENT_IMAGE_NAME?.trim();
    await persistEnvironment(requiredEnv("AZURE_ENV_NAME"), {
      ...persisted,
      ...(image ? { SERVICE_AGENT_IMAGE_NAME: image } : {}),
    });
    await setAppConfigurationValues(deployment, {
      AI_FOUNDRY_AGENT_NAME: active.name,
      AI_FOUNDRY_AGENT_VERSION: active.version,
    });
    await grantAgentIdentityRoles(deployment, active.instance_identity?.principal_id);
  });
}

export interface AgentAzdManifestOptions {
  dockerfile: string;
  context: string;
  registry?: string;
  image?: string;
  tag?: string;
}

export function createAgentAzdManifest(
  options: AgentAzdManifestOptions,
): Readonly<Record<string, unknown>> {
  return {
    name: "chatbot-agent",
    services: {
      agent: {
        project: ".",
        host: "azure.ai.agent",
        language: "python",
        docker: {
          path: options.dockerfile,
          context: options.context,
          registry:
            options.registry ?? "${AZURE_CONTAINER_REGISTRY_ENDPOINT}",
          image: options.image ?? "azure-sdk-chat-agent",
          ...(options.tag ? { tag: options.tag } : {}),
          remoteBuild: true,
        },
        kind: "hosted",
        name: agentName,
        description: "Azure SDK Q&A hosted agent",
        protocols: [{ protocol: "responses", version: "2.0.0" }],
        config: { container: { resources: { cpu: "0.5", memory: "1Gi" } } },
        container: { resources: { cpu: "0.5", memory: "1Gi" } },
        startupCommand: "python init.py",
        env: {
          AZURE_APPCONFIG_ENDPOINT: "${AZURE_APPCONFIG_ENDPOINT}",
        },
      },
    },
  };
}

export function parseAgentVersion(output: string): AgentVersion {
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
  return value as AgentVersion;
}

function requiredAzdValue(
  values: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = values[name]?.trim();
  if (!value) throw new Error(`azd deploy did not set '${name}'.`);
  return value;
}

async function grantAgentIdentityRoles(
  deployment: Deployment,
  principalId: string | undefined,
): Promise<void> {
  if (!principalId) {
    throw new Error("Foundry agent version did not return an instance identity.");
  }
  const subscription = requiredEnv("AZURE_SUBSCRIPTION_ID");
  const resourceGroup = requiredEnv("AZURE_RESOURCE_GROUP");
  const providers = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers`;
  const roles: Array<[string, string]> = [
    [
      "App Configuration Data Reader",
      `${providers}/Microsoft.AppConfiguration/configurationStores/${requiredEnv("APP_CONFIG_NAME")}`,
    ],
    [
      "Cognitive Services OpenAI User",
      `${providers}/Microsoft.CognitiveServices/accounts/${requiredEnv("AI_RESOURCE_NAME")}`,
    ],
    [
      "53ca6127-db72-4b80-b1b0-d745d6d5456d",
      `${providers}/Microsoft.CognitiveServices/accounts/${requiredEnv("AI_RESOURCE_NAME")}`,
    ],
    [
      "Storage Blob Data Owner",
      `${providers}/Microsoft.Storage/storageAccounts/${requiredEnv("STORAGE_ACCOUNT_NAME")}`,
    ],
    [
      "Storage Table Data Contributor",
      `${providers}/Microsoft.Storage/storageAccounts/${requiredEnv("STORAGE_ACCOUNT_NAME")}`,
    ],
    [
      "Storage Queue Data Contributor",
      `${providers}/Microsoft.Storage/storageAccounts/${requiredEnv("STORAGE_ACCOUNT_NAME")}`,
    ],
    [
      "Search Index Data Contributor",
      `${providers}/Microsoft.Search/searchServices/${requiredEnv("SEARCH_SERVICE_NAME")}`,
    ],
    [
      "Key Vault Secrets User",
      `${providers}/Microsoft.KeyVault/vaults/${requiredEnv("KEY_VAULT_NAME")}`,
    ],
  ];
  for (const [role, scope] of roles) {
    await ensureRoleAssignment(deployment, { principalId, role, scope });
  }
}