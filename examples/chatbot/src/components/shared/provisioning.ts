import {
  createBicepParameterFile,
  renderBicepParameterFile,
  renderBicepFiles,
} from "@azure/provisioning-bicep";
import {
  fn,
  Stack,
  type ExpressionOrValue,
} from "@azure/provisioning-core";
import { serialize } from "@azure/provisioning-serialization";
import { UserAssignedIdentity } from "@azure/provisioning-managed-identity";
import { ActionGroup } from "@azure/provisioning-monitor";
import { KeyVault } from "@azure/provisioning-keyvault";
import { ConfigurationStore } from "@azure/provisioning-appconfiguration";
import { SearchService } from "@azure/provisioning-search";
import { Registry } from "@azure/provisioning-container-registry";
import {
  BlobService,
  Container,
  StorageAccount,
  Table,
  TableService,
} from "@azure/provisioning-storage";
import {
  Container as CosmosContainer,
  DatabaseAccount,
  SqlDatabase,
  SqlRoleAssignment,
} from "@azure/provisioning-cosmosdb";
import {
  grantRole,
  Role,
  RoleAssignment,
} from "@azure/provisioning-authorization";

const storageBlobDataOwnerRoleId = "b7e6dc6d-f1e8-4753-8033-0f276bb0955b";
const appConfigDataReaderRoleId = "516239f1-63e1-4d78-a4de-a74fb236a071";
const searchIndexDataContributorRoleId = "8ebe5a00-799e-43f5-93ac-243d3dce84a7";
const cosmosDbDataContributorRoleId = "00000000-0000-0000-0000-000000000002";

const stack = new Stack("main", { targetScope: "resourceGroup" });

function stringParameter(
  name: string,
  options?: {
    defaultValue?: ExpressionOrValue<string>;
    description?: string;
  },
) {
  return stack.parameters.add(name, "string", options);
}

const location = stringParameter("location", { defaultValue: "westus2" });
const cosmosDbLocation = stringParameter("cosmosDbLocation", {
  defaultValue: location,
});
const developerGroupObjectId = stringParameter("developerGroupObjectId", {
  defaultValue: "",
});
const developerPrincipalType = stringParameter("developerPrincipalType", {
  defaultValue: "User",
});
const managedIdentityNameOverride = stringParameter("managedIdentityName", {
  defaultValue: "",
});
const actionGroupNameOverride = stringParameter("actionGroupName", {
  defaultValue: "",
});
const keyVaultNameOverride = stringParameter("keyVaultName", {
  defaultValue: "",
});
const appConfigNameOverride = stringParameter("appConfigName", {
  defaultValue: "",
});
const searchServiceNameOverride = stringParameter("searchServiceName", {
  defaultValue: "",
});
const containerRegistryNameOverride = stringParameter(
  "containerRegistryName",
  { defaultValue: "" },
);
const storageAccountNameOverride = stringParameter("storageAccountName", {
  defaultValue: "",
});
const cosmosDbAccountNameOverride = stringParameter("cosmosDbAccountName", {
  defaultValue: "",
});

const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);
const effective = (
  override: ExpressionOrValue<string>,
  fallback: ExpressionOrValue<string>,
) => fn.cond(fn.not(fn.empty(override)), override, fallback);
const suffixed = (prefix: string) => fn.concat(prefix, suffix);

const managedIdentityName = effective(
  managedIdentityNameOverride,
  suffixed("qabot-identity-"),
);
const actionGroupName = effective(
  actionGroupNameOverride,
  suffixed("qabot-alert-"),
);
const keyVaultName = effective(
  keyVaultNameOverride,
  suffixed("qabot-keyvault-"),
);
const appConfigName = effective(
  appConfigNameOverride,
  suffixed("qabot-config-"),
);
const searchServiceName = effective(
  searchServiceNameOverride,
  suffixed("qabot-search-"),
);
const containerRegistryName = effective(
  containerRegistryNameOverride,
  suffixed("qabotcontainer"),
);
const storageAccountName = effective(
  storageAccountNameOverride,
  suffixed("qabotstorage"),
);
const cosmosDbAccountName = effective(
  cosmosDbAccountNameOverride,
  suffixed("qabot-db-"),
);

const identity = new UserAssignedIdentity(stack, {
  name: managedIdentityName,
  location,
});

new ActionGroup(stack, {
  name: actionGroupName,
  location: "Global",
  properties: {
    groupShortName: "Alert",
    enabled: true,
    emailReceivers: [
      {
        name: "Email0_-EmailAction-",
        emailAddress: "azuresdkqabotproject@service.microsoft.com",
        useCommonAlertSchema: true,
      },
    ],
  } as any,
});

const vault = new KeyVault(stack, {
  name: keyVaultName,
  location,
  properties: {
    sku: { family: "A", name: "standard" },
    tenantId: fn.subscription().tenantId,
    networkAcls: {
      bypass: "None",
      defaultAction: "Allow",
    },
    accessPolicies: [],
  },
});

const configurationStore = new ConfigurationStore(stack, {
  name: appConfigName,
  location,
  sku: { name: "standard" },
  properties: {
    encryption: {},
    disableLocalAuth: true,
    defaultKeyValueRevisionRetentionPeriodInSeconds: 2592000,
    dataPlaneProxy: {
      authenticationMode: "Local",
      privateLinkDelegation: "Disabled",
    },
    telemetry: {},
    azureFrontDoor: {},
  } as any,
});

const searchService = new SearchService(stack, {
  name: searchServiceName,
  location,
  sku: { name: "standard" },
  identity: { type: "SystemAssigned" },
  properties: {
    computeType: "Default",
    networkRuleSet: {
      ipRules: [],
      bypass: "None",
    },
    encryptionWithCmk: {
      enforcement: "Unspecified",
    },
    authOptions: {
      aadOrApiKey: {
        aadAuthFailureMode: "http401WithBearerChallenge",
      },
    },
    dataExfiltrationProtections: [],
    semanticSearch: "standard",
    knowledgeRetrieval: "free",
  } as any,
});

const registry = new Registry(stack, {
  name: containerRegistryName,
  location,
  sku: { name: "Standard" },
});

const storageAccount = new StorageAccount(stack, {
  name: storageAccountName,
  location,
  kind: "StorageV2",
  sku: { name: "Standard_RAGRS" },
  properties: {
    dualStackEndpointPreference: {
      publishIpv6Endpoint: false,
    },
    dnsEndpointType: "Standard",
    defaultToOAuthAuthentication: false,
    publicNetworkAccess: "Enabled",
    allowCrossTenantReplication: false,
    minimumTlsVersion: "TLS1_2",
    allowBlobPublicAccess: false,
    allowSharedKeyAccess: false,
    largeFileSharesState: "Enabled",
    networkAcls: {
      defaultAction: "Allow",
      virtualNetworkRules: [],
      ipRules: [],
    },
    supportsHttpsTrafficOnly: true,
    encryption: {
      requireInfrastructureEncryption: false,
      services: {
        file: { keyType: "Account", enabled: true },
        blob: { keyType: "Account", enabled: true },
      },
    },
    accessTier: "Hot",
  } as any,
});

const blobService = new BlobService(storageAccount, {
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 },
    containerDeleteRetentionPolicy: { enabled: true, days: 7 },
    cors: { corsRules: [] },
    isVersioningEnabled: false,
  },
});

for (const name of [
  "bot-configs",
  "evaluation-dataset",
  "feedback",
  "knowledge",
]) {
  new Container(blobService, {
    name,
    properties: {
      immutableStorageWithVersioning: { enabled: false },
      defaultEncryptionScope: "$account-encryption-key",
      denyEncryptionScopeOverride: false,
      publicAccess: "None",
    } as any,
  });
}

const tableService = new TableService(storageAccount, {});
for (const name of [
  "TeamsChannelConversationsDev",
  "TeamsChannelConversationsProd",
]) {
  new Table(tableService, { name });
}

const databaseAccount = new DatabaseAccount(stack, {
  name: cosmosDbAccountName,
  location: cosmosDbLocation,
  kind: "GlobalDocumentDB",
  identity: { type: "None" },
  tags: {
    defaultExperience: "Core (SQL)",
    "hidden-workload-type": "Development/Testing",
    "hidden-cosmos-mmspecial": "",
  },
  properties: {
    publicNetworkAccess: "Enabled",
    enableAutomaticFailover: true,
    enableMultipleWriteLocations: false,
    isVirtualNetworkFilterEnabled: false,
    virtualNetworkRules: [],
    disableKeyBasedMetadataWriteAccess: false,
    enableFreeTier: false,
    enableAnalyticalStorage: false,
    analyticalStorageConfiguration: { schemaType: "WellDefined" },
    databaseAccountOfferType: "Standard",
    defaultIdentity: "FirstPartyIdentity",
    networkAclBypass: "None",
    disableLocalAuth: true,
    enablePartitionMerge: false,
    enableBurstCapacity: false,
    minimalTlsVersion: "Tls12",
    consistencyPolicy: {
      defaultConsistencyLevel: "Session",
      maxIntervalInSeconds: 5,
      maxStalenessPrefix: 100,
    },
    locations: [
      {
        locationName: cosmosDbLocation,
        failoverPriority: 0,
        isZoneRedundant: false,
      },
    ],
    cors: [],
    capabilities: [],
    ipRules: [],
    backupPolicy: {
      type: "Continuous",
      continuousModeProperties: { tier: "Continuous7Days" },
    },
    networkAclBypassResourceIds: [],
  } as any,
});

const sqlDatabase = new SqlDatabase(databaseAccount, {
  name: "azure-sdk-qa-bot",
  properties: {
    resource: { id: "azure-sdk-qa-bot" },
  },
});

const cosmosContainers = [
  ["conversation-mappings", "/conversationId"],
  ["conversation-messages", "/conversationId"],
  ["experience-episodes", "/episodeId"],
  ["thread-mappings", "/threadId"],
] as const;
for (const [name, partitionPath] of cosmosContainers) {
  new CosmosContainer(sqlDatabase, {
    name,
    properties: {
      resource: {
        id: name,
        indexingPolicy: {
          indexingMode: "consistent",
          automatic: true,
          includedPaths: [{ path: "/*" }],
          excludedPaths: [{ path: '/"_etag"/?' }],
        },
        partitionKey: {
          paths: [partitionPath],
          kind: "Hash",
          version: 2,
        },
      },
    },
  });
}

grantRole(storageAccount, {
  role: storageBlobDataOwnerRoleId,
  principalId: identity.properties.principalId as any,
  principalKey: identity.id,
  principalType: "ServicePrincipal",
});
grantRole(storageAccount, {
  role: Role.StorageQueueDataContributor,
  principalId: identity.properties.principalId as any,
  principalKey: identity.id,
  principalType: "ServicePrincipal",
});
grantRole(storageAccount, {
  role: Role.StorageTableDataContributor,
  principalId: identity.properties.principalId as any,
  principalKey: identity.id,
  principalType: "ServicePrincipal",
});
grantRole(vault, {
  role: Role.KeyVaultSecretsUser,
  principalId: identity.properties.principalId as any,
  principalKey: identity.id,
  principalType: "ServicePrincipal",
});
grantRole(vault, {
  role: Role.KeyVaultSecretsOfficer,
  principalId: identity.properties.principalId as any,
  principalKey: identity.id,
  principalType: "ServicePrincipal",
});
grantRole(configurationStore, {
  role: appConfigDataReaderRoleId,
  principalId: identity.properties.principalId as any,
  principalKey: identity.id,
  principalType: "ServicePrincipal",
});
grantRole(searchService, {
  role: searchIndexDataContributorRoleId,
  principalId: identity.properties.principalId as any,
  principalKey: identity.id,
  principalType: "ServicePrincipal",
});
grantRole(registry, {
  role: Role.Contributor,
  principalId: identity.properties.principalId as any,
  principalKey: identity.id,
  principalType: "ServicePrincipal",
});
grantRole(registry, {
  role: Role.AcrPull,
  principalId: identity.properties.principalId as any,
  principalKey: identity.id,
  principalType: "ServicePrincipal",
});

new SqlRoleAssignment(databaseAccount, {
  name: fn.guid(
    databaseAccount.id,
    identity.id,
    cosmosDbDataContributorRoleId,
  ),
  properties: {
    roleDefinitionId: fn.concat(
      databaseAccount.id,
      `/sqlRoleDefinitions/${cosmosDbDataContributorRoleId}`,
    ) as any,
    principalId: identity.properties.principalId as any,
    scope: databaseAccount.id as any,
  },
});

const developerCondition = fn.not(fn.empty(developerGroupObjectId));

new RoleAssignment(
  storageAccount,
  {
    name: fn.guid(
      storageAccount.id,
      developerGroupObjectId,
      fn.subscriptionResourceId(
        "Microsoft.Authorization/roleDefinitions",
        Role.StorageBlobDataContributor,
      ),
    ),
    properties: {
      roleDefinitionId: fn.subscriptionResourceId(
        "Microsoft.Authorization/roleDefinitions",
        Role.StorageBlobDataContributor,
      ),
      principalId: developerGroupObjectId,
      principalType: developerPrincipalType as any,
    },
  },
  { condition: developerCondition },
);

new RoleAssignment(
  configurationStore,
  {
    name: fn.guid(
      configurationStore.id,
      developerGroupObjectId,
      fn.subscriptionResourceId(
        "Microsoft.Authorization/roleDefinitions",
        appConfigDataReaderRoleId,
      ),
    ),
    properties: {
      roleDefinitionId: fn.subscriptionResourceId(
        "Microsoft.Authorization/roleDefinitions",
        appConfigDataReaderRoleId,
      ),
      principalId: developerGroupObjectId,
      principalType: developerPrincipalType as any,
    },
  },
  { condition: developerCondition },
);

new RoleAssignment(
  vault,
  {
    name: fn.guid(
      vault.id,
      developerGroupObjectId,
      fn.subscriptionResourceId(
        "Microsoft.Authorization/roleDefinitions",
        Role.KeyVaultSecretsOfficer,
      ),
    ),
    properties: {
      roleDefinitionId: fn.subscriptionResourceId(
        "Microsoft.Authorization/roleDefinitions",
        Role.KeyVaultSecretsOfficer,
      ),
      principalId: developerGroupObjectId,
      principalType: developerPrincipalType as any,
    },
  },
  { condition: developerCondition },
);

new RoleAssignment(
  registry,
  {
    name: fn.guid(
      registry.id,
      developerGroupObjectId,
      fn.subscriptionResourceId(
        "Microsoft.Authorization/roleDefinitions",
        Role.Contributor,
      ),
    ),
    properties: {
      roleDefinitionId: fn.subscriptionResourceId(
        "Microsoft.Authorization/roleDefinitions",
        Role.Contributor,
      ),
      principalId: developerGroupObjectId,
      principalType: developerPrincipalType as any,
    },
  },
  { condition: developerCondition },
);

new SqlRoleAssignment(
  databaseAccount,
  {
    name: fn.guid(
      databaseAccount.id,
      developerGroupObjectId,
      cosmosDbDataContributorRoleId,
    ),
    properties: {
      roleDefinitionId: fn.concat(
        databaseAccount.id,
        `/sqlRoleDefinitions/${cosmosDbDataContributorRoleId}`,
      ) as any,
      principalId: developerGroupObjectId as any,
      scope: databaseAccount.id as any,
    },
  },
  { condition: developerCondition },
);

const outputs: Array<[string, ExpressionOrValue<string>]> = [
  ["AZURE_RESOURCE_GROUP", fn.resourceGroup().name],
  ["AZURE_LOCATION", location],
  ["MANAGED_IDENTITY_NAME", identity.name],
  ["MANAGED_IDENTITY_CLIENT_ID", identity.properties.clientId as any],
  ["MANAGED_IDENTITY_RESOURCE_ID", identity.id],
  ["MANAGED_IDENTITY_PRINCIPAL_ID", identity.properties.principalId as any],
  ["STORAGE_ACCOUNT_NAME", storageAccount.name],
  ["STORAGE_BLOB_ENDPOINT", storageAccount.properties.primaryEndpoints!.blob as any],
  ["KEY_VAULT_NAME", vault.name],
  ["APP_CONFIG_NAME", configurationStore.name],
  ["SEARCH_SERVICE_NAME", searchService.name],
  ["CONTAINER_REGISTRY_NAME", registry.name],
  ["CONTAINER_REGISTRY_LOGIN_SERVER", registry.properties.loginServer as any],
  ["AZURE_CONTAINER_REGISTRY_ENDPOINT", registry.properties.loginServer as any],
  ["COSMOSDB_ACCOUNT_NAME", databaseAccount.name],
  ["ACTION_GROUP_NAME", actionGroupName],
  [
    "AZURE_APPCONFIG_ENDPOINT",
    fn.concat("https://", configurationStore.name, ".azconfig.io"),
  ],
];
for (const [name, value] of outputs) {
  stack.outputs.add(name, "string", value);
}

const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    cosmosDbLocation: fn.readEnvironmentVariable(
      "COSMOS_DB_LOCATION",
      fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    ),
    developerGroupObjectId: fn.readEnvironmentVariable(
      "DEVELOPER_PRINCIPAL_ID",
      "",
    ),
    developerPrincipalType: fn.readEnvironmentVariable(
      "DEVELOPER_PRINCIPAL_TYPE",
      "User",
    ),
    managedIdentityName: fn.readEnvironmentVariable(
      "MANAGED_IDENTITY_NAME",
      "",
    ),
    actionGroupName: fn.readEnvironmentVariable("ACTION_GROUP_NAME", ""),
    keyVaultName: fn.readEnvironmentVariable("KEY_VAULT_NAME", ""),
    appConfigName: fn.readEnvironmentVariable("APP_CONFIG_NAME", ""),
    searchServiceName: fn.readEnvironmentVariable("SEARCH_SERVICE_NAME", ""),
    containerRegistryName: fn.readEnvironmentVariable(
      "CONTAINER_REGISTRY_NAME",
      "",
    ),
    storageAccountName: fn.readEnvironmentVariable("STORAGE_ACCOUNT_NAME", ""),
    cosmosDbAccountName: fn.readEnvironmentVariable(
      "COSMOSDB_ACCOUNT_NAME",
      "",
    ),
  },
});

export const outputJson = serialize([stack]);
const [renderedStack] = renderBicepFiles(outputJson);
if (renderedStack === undefined) {
  throw new Error("Shared provisioning produced no Bicep entry file.");
}
export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];