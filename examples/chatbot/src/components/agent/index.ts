import {
  deployHostedAgentService,
  type HostedAgentConfiguration,
} from "../../runtime/services/hosted-agent.js";

import {
  ensureRoleAssignment,
  type Deployment,
} from "iac-composer";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  agentRoot,
  generatedAgentLayer,
  generatedRoot,
} from "../../runtime/paths.js";
import {
  seedRuntimeConfiguration,
  setAppConfigurationValues,
} from "../shared/configuration.js";
import { configureServerApplication } from "../shared/identity.js";

const agentName = "azure-sdk-chat-agent";
const foundryUserRoleId = "53ca6127-db72-4b80-b1b0-d745d6d5456d";

export async function agent(deployment: Deployment): Promise<void> {
  const result = await deployHostedAgentService(deployment, {
    service: "agent",
    directory: generatedRoot,
    sourceDirectory: agentRoot,
    provision: {
      layer: generatedAgentLayer,
      deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-agent`,
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: requiredEnv("AZURE_LOCATION"),
    },
    configuration: async (outputs) => {
      if (deployment.dryRun) await configureServerApplication(deployment);
      await deployment.deploy("persist, configure, and seed agent infrastructure", async () => {
        await persistEnvironment(deployment, outputs);
        await ensureAgentServerFoundryAccess(deployment);
        await configureServerApplication(deployment);
        await seedRuntimeConfiguration(deployment);
      });
      return createAgentServiceConfiguration({
        tag: process.env.AGENT_IMAGE_TAG?.trim(),
        appConfigurationEndpoint: deployment.dryRun
          ? "${AZURE_APPCONFIG_ENDPOINT}"
          : requiredEnv("AZURE_APPCONFIG_ENDPOINT"),
      });
    },
  });

  await deployment.deploy("persist and configure hosted agent outputs", async () => {
    if (result.status !== "deployed") {
      throw new Error("Hosted agent outputs require a completed deployment.");
    }
    const values = result.deploymentOutputs;
    const active = result.agent;
    const persisted = {
      AGENT_AGENT_NAME: active.name,
      AGENT_AGENT_VERSION: active.version,
      AGENT_AGENT_ENDPOINT: result.endpoint,
      AGENT_AGENT_RESPONSES_ENDPOINT: requiredAzdValue(
        values,
        "AGENT_AGENT_RESPONSES_ENDPOINT",
      ),
    };
    const image = values.SERVICE_AGENT_IMAGE_NAME?.trim();
    await persistEnvironment(deployment, {
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

export interface AgentServiceConfigurationOptions {
  registry?: string;
  image?: string;
  tag?: string;
  appConfigurationEndpoint: string;
}

export function createAgentServiceConfiguration(
  options: AgentServiceConfigurationOptions,
): HostedAgentConfiguration {
  return {
    language: "python",
    docker: {
      path: "agents/chat_agent/Dockerfile",
      context: ".",
      registry: options.registry ?? "${AZURE_CONTAINER_REGISTRY_ENDPOINT}",
      image: options.image ?? "azure-sdk-chat-agent",
      ...(options.tag ? { tag: options.tag } : {}),
      remoteBuild: true,
    },
    name: agentName,
    description: "Azure SDK Q&A hosted agent",
    protocols: [{ protocol: "responses", version: "2.0.0" }],
    container: { cpu: "0.5", memory: "1Gi" },
    startupCommand: "python init.py",
    environment: { AZURE_APPCONFIG_ENDPOINT: options.appConfigurationEndpoint },
    deploymentValues: {
      AZURE_CONTAINER_REGISTRY_ENDPOINT: process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
      AZURE_AI_PROJECT_ID: process.env.AZURE_AI_PROJECT_ID,
      FOUNDRY_PROJECT_ENDPOINT: process.env.FOUNDRY_PROJECT_ENDPOINT,
    },
  };
}

async function ensureAgentServerFoundryAccess(
  deployment: Deployment,
): Promise<void> {
  const subscription = requiredEnv("AZURE_SUBSCRIPTION_ID");
  const resourceGroup = requiredEnv("AZURE_RESOURCE_GROUP");
  await ensureRoleAssignment(deployment, {
    principalId: requiredEnv("MANAGED_IDENTITY_PRINCIPAL_ID"),
    role: foundryUserRoleId,
    scope: `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${requiredEnv("AI_RESOURCE_NAME")}`,
  });
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