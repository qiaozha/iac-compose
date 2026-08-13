import {
  bicepRef,
  createBicepParameterFile,
  renderBicepParameterFile,
  renderBicepFiles,
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
import { renderGraphStack } from "../shared/graph-provisioning.js";


export const solutionName = "contoso-support";

const stack = new Stack("main", { targetScope: "resourceGroup" });
const location = stack.parameters.add("location", "string");
const inputAI_RESOURCE_NAME = stack.parameters.add("inputAI_RESOURCE_NAME", "string");
const inputAI_PROJECT_NAME = stack.parameters.add("inputAI_PROJECT_NAME", "string");
const inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME = stack.parameters.add("inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME", "string");
const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);

const foundryProjectAccount = new Account(stack, {
  name: inputAI_RESOURCE_NAME,
  existing: true,
});

const foundryProjectProject = new Project(foundryProjectAccount, {
  name: inputAI_PROJECT_NAME,
  existing: true,
});

new ModelDeployment(foundryProjectAccount, {
  name: "gpt-5.4",
  sku: { name: "GlobalStandard", capacity: 1 },
  properties: {
    model: {
      format: "OpenAI",
      name: "gpt-5.4",
      version: "2026-03-05",
    },
    versionUpgradeOption: "OnceNewDefaultVersionAvailable",
  } as any,
});

const runtimeConfigurationStore = new ConfigurationStore(stack, {
  name: inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME,
  existing: true,
});

new KeyValue(runtimeConfigurationStore, {
  name: "AI_FOUNDRY_AGENT_COMPLETION_MODEL",
  properties: {
    value: "gpt-5.4",
  },
});

stack.outputs.add("foundryModelDeploymentName", "string", "gpt-5.4");
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    inputAI_RESOURCE_NAME: fn.readEnvironmentVariable("AI_RESOURCE_NAME"),
    inputAI_PROJECT_NAME: fn.readEnvironmentVariable("AI_PROJECT_NAME"),
    inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME: fn.readEnvironmentVariable("DEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME"),
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
