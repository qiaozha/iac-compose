import {
  bicepRef,
  createBicepParameterFile,
  renderBicepFile,
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
const inputDEPLOY_REGISTRY_NAME = stack.parameters.add("inputDEPLOY_REGISTRY_NAME", "string");
const inputBackendBaseUrl = stack.parameters.add("inputBackendBaseUrl", "string");
const inputBackendAudience = stack.parameters.add("inputBackendAudience", "string");
const inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME = stack.parameters.add("inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME", "string");
const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);

const deploymentRegistry = new Registry(stack, {
  name: inputDEPLOY_REGISTRY_NAME,
  existing: true,
});

const botIdentityIdentity = new UserAssignedIdentity(stack, {
  name: fn.concat("contoso-support-botidentity-", suffix),
  location,
});

const frontendComputeIdentity = new UserAssignedIdentity(stack, {
  name: fn.concat("contoso-support-frontendcompute-identity-", suffix),
  location,
});

const frontendComputePlan = new AppServicePlan(stack, {
  name: fn.concat("contoso-support-frontendcomput-p-", suffix),
  location,
  kind: "linux",
  sku: { name: "B1", tier: "Basic", capacity: 1 },
  properties: { reserved: true },
});

const frontendComputeSite = new Site(stack, {
  name: fn.concat("contoso-support-frontendcompute-", suffix),
  location,
  kind: "app,linux,container",
  tags: { "azd-service-name": "frontend" },
  identity: {
    type: "UserAssigned",
    userAssignedIdentities: fn.union(
      fn.json(fn.concat('{"', frontendComputeIdentity.id, '":{}}')),
      fn.json(fn.concat('{"', botIdentityIdentity.id, '":{}}')),
    ) as any,
  },
  properties: {
    serverFarmId: frontendComputePlan.id as any,
    httpsOnly: true,
    siteConfig: {
      linuxFxVersion: "DOCKER|mcr.microsoft.com/azuredocs/aci-helloworld:latest",
      alwaysOn: true,
      acrUseManagedIdentityCreds: true,
      acrUserManagedIdentityID: frontendComputeIdentity.properties.clientId as any,
      healthCheckPath: "/health",
      appSettings: [
        { name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE", value: "false" },
        { name: "WEBSITES_PORT", value: "3978" },
        { name: "BOT_ID", value: botIdentityIdentity.properties.clientId as any },
        { name: "BOT_TENANT_ID", value: botIdentityIdentity.properties.tenantId as any },
        { name: "BOT_TYPE", value: "UserAssignedMSI" },
        { name: "BOT_DISPLAY_NAME", value: "Contoso Support" },
        { name: "BACKEND_BASE_URL", value: inputBackendBaseUrl },
        { name: "BACKEND_SCOPE", value: inputBackendAudience },
        { name: "USER_ASSIGNED_IDENTITY_CLIENT_ID", value: botIdentityIdentity.properties.clientId as any }
      ],
    },
  } as any,
});

new RoleAssignment(deploymentRegistry, {
  name: fn.guid(
    deploymentRegistry.id,
    frontendComputeIdentity.id,
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
    principalId: frontendComputeIdentity.properties.principalId as any,
    principalType: "ServicePrincipal",
  },
});

const botIdentityBot = new Bot(stack, {
  name: fn.concat("contoso-support-botidentity-bot-", suffix),
  location: "global",
  kind: "azurebot",
  sku: { name: "F0" },
  properties: {
    displayName: "contoso-support",
    endpoint: fn.concat(fn.concat("https://", frontendComputeSite.properties.defaultHostName as any), "/api/messages"),
    msaAppId: botIdentityIdentity.properties.clientId as any,
    msaAppTenantId: botIdentityIdentity.properties.tenantId as any,
    msaAppType: "UserAssignedMSI",
    msaAppMSIResourceId: botIdentityIdentity.id as any,
  },
});

new Channel(botIdentityBot, {
  name: "MsTeamsChannel",
  location: "global",
  properties: { channelName: "MsTeamsChannel", location: "global" } as any,
});

const runtimeConfigurationStore = new ConfigurationStore(stack, {
  name: inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME,
  existing: true,
});

new KeyValue(runtimeConfigurationStore, {
  name: "TEAMS_BOT_ID",
  properties: {
    value: botIdentityIdentity.properties.clientId as any,
  },
});

new RoleAssignment(deploymentRegistry, {
  name: fn.guid(
    deploymentRegistry.id,
    botIdentityIdentity.id,
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
    principalId: botIdentityIdentity.properties.principalId as any as any,
    principalType: "ServicePrincipal",
  },
});

stack.outputs.add("frontendBaseUrl", "string", fn.concat("https://", frontendComputeSite.properties.defaultHostName as any));
stack.outputs.add("botClientId", "string", botIdentityIdentity.properties.clientId as any);
stack.outputs.add("botIdentityPrincipalId", "string", botIdentityIdentity.properties.principalId as any);
stack.outputs.add("botIdentityResourceId", "string", botIdentityIdentity.id);
stack.outputs.add("tenantId", "string", botIdentityIdentity.properties.tenantId as any);
stack.outputs.add("DEPLOY_RESOURCE_FRONTENDCOMPUTE_NAME", "string", frontendComputeSite.name);
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    inputDEPLOY_REGISTRY_NAME: fn.readEnvironmentVariable("DEPLOY_REGISTRY_NAME"),
    inputBackendBaseUrl: fn.readEnvironmentVariable("backendBaseUrl"),
    inputBackendAudience: fn.readEnvironmentVariable("backendAudience"),
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
  renderBicepFile(parameterFile),
];
