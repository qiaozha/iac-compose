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
const inputAppConfigurationEndpoint = stack.parameters.add("inputAppConfigurationEndpoint", "string");
const inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME = stack.parameters.add("inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME", "string");
const inputAI_RESOURCE_NAME = stack.parameters.add("inputAI_RESOURCE_NAME", "string");
const inputAI_PROJECT_NAME = stack.parameters.add("inputAI_PROJECT_NAME", "string");
const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);

const deploymentRegistry = new Registry(stack, {
  name: inputDEPLOY_REGISTRY_NAME,
  existing: true,
});

const stateStoreAccount = new DatabaseAccount(stack, {
  name: fn.concat("contososupportstatestore", suffix),
  location,
  kind: "GlobalDocumentDB",
  properties: {
    databaseAccountOfferType: "Standard",
    disableLocalAuth: true,
    publicNetworkAccess: "Enabled",
    minimalTlsVersion: "Tls12",
    consistencyPolicy: { defaultConsistencyLevel: "Session" },
    locations: [
      { locationName: location, failoverPriority: 0, isZoneRedundant: false },
    ],
  } as any,
});

const stateStoreDatabase = new SqlDatabase(stateStoreAccount, {
  name: "support-agent",
  properties: {
    resource: { id: "support-agent" },
    options: { throughput: 400 },
  } as any,
});

new CosmosContainer(stateStoreDatabase, {
  name: "conversation-mappings",
  properties: {
    resource: {
      id: "conversation-mappings",
      partitionKey: {
        paths: ["/mapping_key"],
        kind: "Hash",
        version: 2,
      },
    },
  } as any,
});

new CosmosContainer(stateStoreDatabase, {
  name: "conversation-messages",
  properties: {
    resource: {
      id: "conversation-messages",
      partitionKey: {
        paths: ["/conversation_partition"],
        kind: "Hash",
        version: 2,
      },
    },
  } as any,
});

const feedbackStorageAccount = new StorageAccount(stack, {
  name: fn.concat("contososupportfeed", suffix),
  location,
  kind: "StorageV2",
  sku: { name: "Standard_LRS" },
  properties: {
    minimumTlsVersion: "TLS1_2",
    allowBlobPublicAccess: false,
    allowSharedKeyAccess: false,
    supportsHttpsTrafficOnly: true,
  } as any,
});

const feedbackStorageBlobService = new BlobService(feedbackStorageAccount, {});

new StorageContainer(feedbackStorageBlobService, {
  name: "feedback",
  properties: { publicAccess: "None" },
});

const backendComputeAudience = fn.concat(
  "api://contoso-support-backendcompute-",
  suffix,
);
const backendComputeApplicationAppId = bicepRef<string>("backendComputeApplication.appId");

const backendComputeIdentity = new UserAssignedIdentity(stack, {
  name: fn.concat("contoso-support-backendcompute-identity-", suffix),
  location,
});

const backendComputePlan = new AppServicePlan(stack, {
  name: fn.concat("contoso-support-backendcompute-p-", suffix),
  location,
  kind: "linux",
  sku: { name: "B1", tier: "Basic", capacity: 1 },
  properties: { reserved: true },
});

const backendComputeSite = new Site(stack, {
  name: fn.concat("contoso-support-backendcompute-", suffix),
  location,
  kind: "app,linux,container",
  tags: { "azd-service-name": "backend" },
  identity: {
    type: "UserAssigned",
    userAssignedIdentities: fn.json(fn.concat('{"', backendComputeIdentity.id, '":{}}')) as any,
  },
  properties: {
    serverFarmId: backendComputePlan.id as any,
    httpsOnly: true,
    siteConfig: {
      linuxFxVersion: "DOCKER|mcr.microsoft.com/azuredocs/aci-helloworld:latest",
      alwaysOn: true,
      acrUseManagedIdentityCreds: true,
      acrUserManagedIdentityID: backendComputeIdentity.properties.clientId as any,
      healthCheckPath: "/ping",
      appSettings: [
        { name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE", value: "false" },
        { name: "WEBSITES_PORT", value: "8089" },
        { name: "AZURE_CLIENT_ID", value: backendComputeIdentity.properties.clientId as any },
        { name: "AZURE_APPCONFIG_ENDPOINT", value: inputAppConfigurationEndpoint }
      ],
    },
  } as any,
});

new SiteConfigAuthsettingsV2(backendComputeSite, {
  properties: {
    platform: { enabled: true, runtimeVersion: "~1" },
    globalValidation: {
      requireAuthentication: true,
      unauthenticatedClientAction: "Return401",
      excludedPaths: ["/ping"],

    },
    identityProviders: {
      azureActiveDirectory: {
        enabled: true,
        registration: {
          clientId: backendComputeApplicationAppId,
          openIdIssuer: fn.concat(
            (fn.environment() as any).authentication.loginEndpoint,
            fn.tenant().tenantId,
            "/v2.0",
          ) as any,
        },
        validation: {
          allowedAudiences: [backendComputeApplicationAppId, backendComputeAudience],
        },
      },
    },
    login: { tokenStore: { enabled: true } },
  } as any,
});

const runtimeConfigurationStore = new ConfigurationStore(stack, {
  name: inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME,
  existing: true,
});

new KeyValue(runtimeConfigurationStore, {
  name: "AZURE_COSMOSDB_ENDPOINT",
  properties: {
    value: stateStoreAccount.properties.documentEndpoint as any,
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "AZURE_COSMOSDB_DATABASE",
  properties: {
    value: stateStoreDatabase.name,
  },
});

new KeyValue(runtimeConfigurationStore, {
  name: "STORAGE_BASE_URL",
  properties: {
    value: feedbackStorageAccount.properties.primaryEndpoints!.blob as any,
  },
});

const foundryProjectAccount = new Account(stack, {
  name: inputAI_RESOURCE_NAME,
  existing: true,
});

const foundryProjectProject = new Project(foundryProjectAccount, {
  name: inputAI_PROJECT_NAME,
  existing: true,
});

new RoleAssignment(foundryProjectProject, {
  name: fn.guid(
    foundryProjectProject.id,
    backendComputeIdentity.id,
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "53ca6127-db72-4b80-b1b0-d745d6d5456d",
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "53ca6127-db72-4b80-b1b0-d745d6d5456d",
    ),
    principalId: backendComputeIdentity.properties.principalId as any as any,
    principalType: "ServicePrincipal",
  },
});

new SqlRoleAssignment(stateStoreAccount, {
  name: fn.guid(
    stateStoreAccount.id,
    backendComputeIdentity.id,
    "00000000-0000-0000-0000-000000000002",
  ),
  properties: {
    roleDefinitionId: fn.concat(
      stateStoreAccount.id,
      "/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002",
    ) as any,
    principalId: backendComputeIdentity.properties.principalId as any as any,
    scope: stateStoreAccount.id as any,
  },
});

new RoleAssignment(feedbackStorageAccount, {
  name: fn.guid(
    feedbackStorageAccount.id,
    backendComputeIdentity.id,
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
    ),
    principalId: backendComputeIdentity.properties.principalId as any as any,
    principalType: "ServicePrincipal",
  },
});

new RoleAssignment(runtimeConfigurationStore, {
  name: fn.guid(
    runtimeConfigurationStore.id,
    backendComputeIdentity.id,
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "516239f1-63e1-4d78-a4de-a74fb236a071",
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "516239f1-63e1-4d78-a4de-a74fb236a071",
    ),
    principalId: backendComputeIdentity.properties.principalId as any as any,
    principalType: "ServicePrincipal",
  },
});

new RoleAssignment(deploymentRegistry, {
  name: fn.guid(
    deploymentRegistry.id,
    backendComputeIdentity.id,
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
    principalId: backendComputeIdentity.properties.principalId as any as any,
    principalType: "ServicePrincipal",
  },
});

stack.outputs.add("cosmosEndpoint", "string", stateStoreAccount.properties.documentEndpoint as any);
stack.outputs.add("cosmosDatabase", "string", stateStoreDatabase.name);
stack.outputs.add("storageBlobEndpoint", "string", feedbackStorageAccount.properties.primaryEndpoints!.blob as any);
stack.outputs.add("backendBaseUrl", "string", fn.concat("https://", backendComputeSite.properties.defaultHostName as any));
stack.outputs.add("backendAudience", "string", backendComputeAudience);
stack.outputs.add("backendIdentityPrincipalId", "string", backendComputeIdentity.properties.principalId as any);
stack.outputs.add("backendIdentityResourceId", "string", backendComputeIdentity.id);
stack.outputs.add("DEPLOY_RESOURCE_STATESTORE_NAME", "string", stateStoreAccount.name);
stack.outputs.add("DEPLOY_RESOURCE_FEEDBACKSTORAGE_NAME", "string", feedbackStorageAccount.name);
stack.outputs.add("DEPLOY_RESOURCE_BACKENDCOMPUTE_NAME", "string", backendComputeSite.name);
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    inputDEPLOY_REGISTRY_NAME: fn.readEnvironmentVariable("DEPLOY_REGISTRY_NAME"),
    inputAppConfigurationEndpoint: fn.readEnvironmentVariable("appConfigurationEndpoint"),
    inputDEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME: fn.readEnvironmentVariable("DEPLOY_RESOURCE_RUNTIMECONFIGURATION_NAME"),
    inputAI_RESOURCE_NAME: fn.readEnvironmentVariable("AI_RESOURCE_NAME"),
    inputAI_PROJECT_NAME: fn.readEnvironmentVariable("AI_PROJECT_NAME"),
  },
});

const rendered = renderGraphStack(stack, [
  {
    identifier: "backendComputeApplication",
    type: "Microsoft.Graph/applications",
    body: {
      uniqueName: fn.concat("contoso-support-backendcompute-api-", suffix),
      displayName: "contoso-support backendCompute API",
      signInAudience: "AzureADMyOrg",
      serviceManagementReference: "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4",
      identifierUris: [backendComputeAudience],
      api: { requestedAccessTokenVersion: 2 },
    },
  },
  {
    identifier: "backendComputeServicePrincipal",
    type: "Microsoft.Graph/servicePrincipals",
    body: { appId: backendComputeApplicationAppId },
  },
]);
export const outputJson = rendered.outputJson;
const renderedStack = rendered.main;
if (renderedStack === undefined) {
  throw new Error("Generated provisioning produced no Bicep entry file.");
}
export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepFile(parameterFile),
];
