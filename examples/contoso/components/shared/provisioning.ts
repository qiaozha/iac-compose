import {
  bicepRef,
  createBicepParameterFile,
  renderBicepFiles,
  renderBicepParameterFile,
} from "@azure/provisioning-bicep";
import { fn, Stack } from "@azure/provisioning-core";
import { serialize } from "@azure/provisioning-serialization";
import {
  Account,
  Deployment as ModelDeployment,
  Project,
} from "@azure/provisioning-cognitiveservices";
import {
  Container as CosmosContainer,
  DatabaseAccount,
  SqlDatabase,
  SqlRoleAssignment,
} from "@azure/provisioning-cosmosdb";
import {
  BlobService,
  Container as StorageContainer,
  StorageAccount,
} from "@azure/provisioning-storage";
import {
  ConfigurationStore,
  KeyValue,
} from "@azure/provisioning-appconfiguration";
import { Workspace } from "@azure/provisioning-operationalinsights";
import { ApplicationInsightsComponent } from "@azure/provisioning-applicationinsights";
import { UserAssignedIdentity } from "@azure/provisioning-managed-identity";
import { Registry } from "@azure/provisioning-container-registry";
import {
  ApiConnection,
  AppServicePlan,
  Site,
  SiteConfigAuthsettingsV2,
} from "@azure/provisioning-appservice";
import { Bot, Channel } from "@azure/provisioning-botservice";
import { RoleAssignment } from "@azure/provisioning-authorization";
import { Workflow } from "@azure/provisioning-logic";
import { renderGraphStack } from "./graph-provisioning.js";


export const solutionName = "contoso-support";

const stack = new Stack("main", { targetScope: "resourceGroup" });
const location = stack.parameters.add("location", "string");
const inputAZURE_AI_LOCATION = stack.parameters.add("inputAZURE_AI_LOCATION", "string");
const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);

const deploymentRegistry = new Registry(stack, {
  name: fn.concat("contososupportregistry", suffix),
  location,
  sku: { name: "Basic" },
  properties: { adminUserEnabled: false },
});

const foundryProjectLocationSuffix = stack.variables.add(
  "foundryProjectLocationSuffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id, inputAZURE_AI_LOCATION), 0, 6),
);

const foundryProjectAccount = new Account(stack, {
  name: fn.concat("contoso-support-foundryproject-ai-", foundryProjectLocationSuffix),
  location: inputAZURE_AI_LOCATION,
  kind: "AIServices",
  sku: { name: "S0" },
  identity: { type: "SystemAssigned" },
  properties: {
    customSubDomainName: fn.concat("contoso-support-foundryproject-ai-", foundryProjectLocationSuffix),
    allowProjectManagement: true,
    publicNetworkAccess: "Enabled",
    disableLocalAuth: true,
  } as any,
});

const foundryProjectProject = new Project(foundryProjectAccount, {
  name: fn.concat("contoso-support-foundryproject-project-", foundryProjectLocationSuffix),
  location: inputAZURE_AI_LOCATION,
  identity: { type: "SystemAssigned" },
  properties: {} as any,
});



new RoleAssignment(deploymentRegistry, {
  name: fn.guid(
    deploymentRegistry.id,
    foundryProjectProject.id,
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "7f951dda-4ed3-4680-a7ca-43fe172d538d",
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "7f951dda-4ed3-4680-a7ca-43fe172d538d",
    ),
    principalId: foundryProjectProject.identity.principalId as any,
    principalType: "ServicePrincipal",
  },
});


const runtimeConfigurationStore = new ConfigurationStore(stack, {
  name: fn.concat("contoso-support-runtimeconfiguration-", suffix),
  location,
  sku: { name: "standard" },
  properties: {
    disableLocalAuth: true,
            publicNetworkAccess: "Enabled",
            dataPlaneProxy: { authenticationMode: "Pass-through" },
  } as any,
});

new KeyValue(runtimeConfigurationStore, {
  name: "AI_FOUNDRY_PROJECT_ENDPOINT",
  properties: {
    value: fn.concat("https://", foundryProjectAccount.name, ".services.ai.azure.com/api/projects/", foundryProjectProject.name),
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "AI_FOUNDRY_AGENT_NAME",
  properties: {
    value: "contoso-support-agent",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "AGENT_INSTRUCTIONS",
  properties: {
    value: "You are Contoso Support, the customer-facing AI support assistant for Contoso.\n\nIdentity and company context:\n- Contoso Corporation is a multinational manufacturing, sales, and support organization headquartered in Paris. It has offices around the world and a portfolio of more than 100,000 products.\n- \"Contoso Support\" is Contoso's AI support assistant. Your role is to help users understand Contoso, its products and services, and the business and technical topics covered by the available Contoso documentation.\n- If asked \"What is Contoso?\", describe the company and then explain your role. A good concise answer is: \"Contoso Corporation is a multinational manufacturing, sales, and support organization headquartered in Paris. Contoso Support is its AI assistant for questions about the company, its products and services, and its documented business and technical environment.\"\n- Add company, product, or technology details only when they are established by the configured knowledge sources or the conversation.\n\nAnswering behavior:\n- Answer questions within the Contoso support scope clearly, directly, and professionally. Start with the most useful answer, then provide relevant background, steps, or caveats.\n- Prefer the configured Contoso sources and cite the source URLs used for factual claims when citations are available.\n- Keep source-grounded facts separate from general recommendations. Do not transfer details from unrelated scenarios unless the configured sources connect them.\n- If the sources do not establish a requested detail, say that it is not specified in the available documentation. Ask a focused clarifying question or suggest the most relevant next step instead of guessing.\n- Never invent Contoso products, infrastructure, policies, implementation status, links, or support commitments.\n- For requests outside the Contoso support scope, briefly explain your role and redirect the user to a relevant topic when possible.\n",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "ASSISTANT_NAME",
  properties: {
    value: "Contoso Support",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "ASSISTANT_SCOPE",
  properties: {
    value: "Contoso Corporation, its products and services, and its documented business and technical environment",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "ENABLE_WEB_SEARCH",
  properties: {
    value: "true",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "WEB_SEARCH_CONTEXT_SIZE",
  properties: {
    value: "medium",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "WEB_SEARCH_SOURCE_HINTS",
  properties: {
    value: "https://learn.microsoft.com/en-us/microsoft-365/enterprise/contoso-overview,https://learn.microsoft.com/en-us/microsoft-365/enterprise/contoso-case-study",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "AZURE_COSMOSDB_MAPPING_CONTAINER",
  properties: {
    value: "conversation-mappings",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "AZURE_COSMOSDB_MESSAGE_CONTAINER",
  properties: {
    value: "conversation-messages",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "STORAGE_FEEDBACK_CONTAINER",
  properties: {
    value: "feedback",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "DEFAULT_LOCALE",
  properties: {
    value: "en-US",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "DEFAULT_TIMEZONE",
  properties: {
    value: "UTC",
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "TEAMS_SERVICE_URL_BASE",
  properties: {
    value: "https://smba.trafficmanager.net/apac",
  },
});

stack.outputs.add("foundryProjectEndpoint", "string", fn.concat("https://", foundryProjectAccount.name, ".services.ai.azure.com/api/projects/", foundryProjectProject.name));
stack.outputs.add("agentName", "string", "contoso-support-agent");
stack.outputs.add("agentVersion", "string", "");
stack.outputs.add("appConfigurationEndpoint", "string", runtimeConfigurationStore.properties.endpoint as any);
stack.outputs.add("containerRegistryName", "string", deploymentRegistry.name);
stack.outputs.add("containerRegistryEndpoint", "string", deploymentRegistry.properties.loginServer as any);
stack.outputs.add("DEPLOY_RESOURCE_SUFFIX", "string", suffix);
stack.outputs.add("DEPLOY_REGISTRY_NAME", "string", deploymentRegistry.name);
stack.outputs.add("AZURE_CONTAINER_REGISTRY_ENDPOINT", "string", deploymentRegistry.properties.loginServer as any);
stack.outputs.add("AZURE_AI_PROJECT_ID", "string", foundryProjectProject.id);
stack.outputs.add("AI_RESOURCE_NAME", "string", foundryProjectAccount.name);
stack.outputs.add("AI_PROJECT_NAME", "string", foundryProjectProject.name);
stack.outputs.add("FOUNDRY_PROJECT_ENDPOINT", "string", fn.concat("https://", foundryProjectAccount.name, ".services.ai.azure.com/api/projects/", foundryProjectProject.name));
stack.outputs.add("DEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME", "string", runtimeConfigurationStore.name);
stack.outputs.add("DEPLOY_RESOURCE_FOUNDRYPROJECT_ACCESS_SCOPE", "string", foundryProjectProject.id);
stack.outputs.add("DEPLOY_RESOURCE_RUNTIMECONFIGURATION_ACCESS_SCOPE", "string", runtimeConfigurationStore.id);
stack.outputs.add("DEPLOY_RESOURCE_CONTAINERREGISTRY_ACCESS_SCOPE", "string", deploymentRegistry.id);
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    inputAZURE_AI_LOCATION: fn.readEnvironmentVariable("AZURE_AI_LOCATION", "eastus"),
  },
});

export const outputJson = serialize([stack]);
const [renderedStack] = renderBicepFiles(outputJson);
if (renderedStack === undefined) {
  throw new Error("Generated provisioning produced no Bicep entry file.");
}
export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];
