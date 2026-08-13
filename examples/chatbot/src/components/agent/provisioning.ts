import {
  createBicepParameterFile,
  renderBicepParameterFile,
  renderBicepFiles,
} from "@azure/provisioning-bicep";
import {
  fn,
  Loop,
  Stack,
  type Expression,
  type ExpressionOrValue,
} from "@azure/provisioning-core";
import { serialize } from "@azure/provisioning-serialization";
import { UserAssignedIdentity } from "@azure/provisioning-managed-identity";
import { Workspace } from "@azure/provisioning-operationalinsights";
import { ApplicationInsightsComponent } from "@azure/provisioning-applicationinsights";
import {
  Account,
  AccountConnection,
  Deployment,
  Project,
  ProjectConnection,
} from "@azure/provisioning-cognitiveservices";
import { Registry } from "@azure/provisioning-container-registry";
import {
  grantRole,
  RoleAssignment,
} from "@azure/provisioning-authorization";

const cognitiveServicesOpenAIUserRoleId =
  "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd";
const foundryProjectManagerRoleId = "eadc314b-1a2d-4efa-be10-5d325db5065e";
const acrPullRoleId = "7f951dda-4ed3-4680-a7ca-43fe172d538d";

AccountConnection.apiVersion = "2026-05-15-preview";
ProjectConnection.apiVersion = "2026-05-15-preview";

interface ModelDeploymentConfig {
  readonly name: string;
  readonly properties: Record<string, unknown>;
  readonly sku: {
    readonly name: string;
    readonly capacity: number;
  };
}

const stack = new Stack("main", { targetScope: "resourceGroup" });

function stringParameter(
  name: string,
  options?: { defaultValue?: ExpressionOrValue<string> },
) {
  return stack.parameters.add(name, "string", options);
}

const location = stringParameter("location");
const botIdentityLocation = stringParameter("botIdentityLocation");
const botIdentityNameOverride = stringParameter("botIdentityName", {
  defaultValue: "",
});
const managedIdentityPrincipalId = stringParameter(
  "managedIdentityPrincipalId",
);
const storageAccountName = stringParameter("storageAccountName");
const storageBlobEndpoint = stringParameter("storageBlobEndpoint");
const containerRegistryName = stringParameter("containerRegistryName");
const developerGroupObjectId = stringParameter("developerGroupObjectId", {
  defaultValue: "",
});
const developerPrincipalType = stringParameter("developerPrincipalType", {
  defaultValue: "User",
});
const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);
const agentLogWorkspaceNameOverride = stringParameter(
  "agentLogWorkspaceName",
  { defaultValue: "" },
);
const agentAppInsightsNameOverride = stringParameter("agentAppInsightsName", {
  defaultValue: "",
});
const aiResourceNameOverride = stringParameter("aiResourceName", {
  defaultValue: "",
});
const aiProjectNameOverride = stringParameter("aiProjectName", {
  defaultValue: "",
});
const effective = (
  override: ExpressionOrValue<string>,
  fallback: ExpressionOrValue<string>,
) => fn.cond(fn.not(fn.empty(override)), override, fallback);
const agentLogWorkspaceName = effective(
  agentLogWorkspaceNameOverride,
  fn.concat("qabot-agent-log-", suffix),
);
const agentAppInsightsName = effective(
  agentAppInsightsNameOverride,
  fn.concat("qabot-agent-", suffix),
);
const aiResourceName = effective(
  aiResourceNameOverride,
  fn.concat("qabot-ai-resource-", suffix),
);
const aiProjectName = effective(aiProjectNameOverride, "qabot-ai");
const botIdentityName = effective(
  botIdentityNameOverride,
  fn.concat("azsdkqabot-", suffix),
);

const botIdentity = new UserAssignedIdentity(stack, {
  name: botIdentityName,
  location: botIdentityLocation,
});

const workspace = new Workspace(stack, {
  name: agentLogWorkspaceName,
  location,
  properties: {
    sku: { name: "PerGB2018" },
    retentionInDays: 30 as any,
  },
});

const appInsights = new ApplicationInsightsComponent(stack, {
  name: agentAppInsightsName,
  location,
  kind: "web",
  properties: {
    Application_Type: "web",
    Flow_Type: "Bluefield",
    Request_Source: "rest",
    RetentionInDays: 90,
    WorkspaceResourceId: workspace.id as any,
  },
});

const account = new Account(stack, {
  name: aiResourceName,
  location,
  kind: "AIServices",
  sku: { name: "S0" },
  identity: { type: "SystemAssigned" },
  properties: {
    apiProperties: {},
    customSubDomainName: aiResourceName,
    networkAcls: {
      defaultAction: "Allow",
      virtualNetworkRules: [],
      ipRules: [],
    },
    allowProjectManagement: true,
    defaultProject: aiProjectName,
    associatedProjects: [aiProjectName],
    publicNetworkAccess: "Enabled",
    disableLocalAuth: true,
  } as any,
});

const modelDeploymentConfigs = stack.variables.add("modelDeploymentConfigs", [
  {
    name: "gpt-4.1",
    properties: {
      model: {
        format: "OpenAI",
        name: "gpt-4.1",
        version: "2025-04-14",
      },
      versionUpgradeOption: "OnceNewDefaultVersionAvailable",
      currentCapacity: 1,
      deploymentState: "Running",
    },
    sku: { name: "GlobalStandard", capacity: 1 },
  },
  {
    name: "gpt-5.4",
    properties: {
      model: {
        format: "OpenAI",
        name: "gpt-5.4",
        version: "2026-03-05",
      },
      versionUpgradeOption: "OnceNewDefaultVersionAvailable",
      currentCapacity: 500,
      serviceTier: "Default",
      deploymentState: "Running",
    },
    sku: { name: "GlobalStandard", capacity: 500 },
  },
  {
    name: "gpt-5.1",
    properties: {
      model: {
        format: "OpenAI",
        name: "gpt-5.1",
        version: "2025-11-13",
      },
      versionUpgradeOption: "OnceNewDefaultVersionAvailable",
      currentCapacity: 1,
      serviceTier: "Default",
      deploymentState: "Running",
    },
    sku: { name: "GlobalStandard", capacity: 1 },
  },
  {
    name: "gpt-5-mini",
    properties: {
      model: {
        format: "OpenAI",
        name: "gpt-5-mini",
        version: "2025-08-07",
      },
      versionUpgradeOption: "OnceNewDefaultVersionAvailable",
      currentCapacity: 1,
      deploymentState: "Running",
    },
    sku: { name: "GlobalStandard", capacity: 1 },
  },
  {
    name: "text-embedding-ada-002",
    properties: {
      model: {
        format: "OpenAI",
        name: "text-embedding-ada-002",
        version: "2",
      },
      versionUpgradeOption: "NoAutoUpgrade",
      currentCapacity: 1,
      deploymentState: "Running",
    },
    sku: { name: "GlobalStandard", capacity: 1 },
  },
]) as Expression<ModelDeploymentConfig[]>;
const modelDeploymentsLoop = new Loop(modelDeploymentConfigs, {
  itemVariable: "deployment",
  batchSize: 1,
});
const modelDeployments = Deployment.fromLoop(modelDeploymentsLoop, account, {
  name: modelDeploymentsLoop.item.name,
  properties: modelDeploymentsLoop.item.properties as any,
  sku: modelDeploymentsLoop.item.sku,
});

new AccountConnection(
  account,
  {
    name: storageAccountName,
    properties: {
      authType: "AAD",
      category: "AzureStorageAccount",
      target: storageBlobEndpoint,
      useWorkspaceManagedIdentity: false,
      isSharedToAll: false,
      sharedUserList: [],
      peRequirement: "NotRequired",
      peStatus: "NotApplicable",
      metadata: {
        ApiType: "Azure",
        ResourceId: fn.resourceId(
          "Microsoft.Storage/storageAccounts",
          storageAccountName,
        ) as any,
      },
    } as any,
  },
  { dependsOn: [modelDeployments] },
);

const project = new Project(account, {
  name: aiProjectName,
  location,
  identity: { type: "SystemAssigned" },
  properties: {} as any,
});

new ProjectConnection(project, {
  name: fn.concat(storageAccountName, "-project"),
  properties: {
    authType: "AAD",
    category: "AzureStorageAccount",
    target: storageBlobEndpoint,
    useWorkspaceManagedIdentity: false,
    isSharedToAll: false,
    sharedUserList: [],
    peRequirement: "NotRequired",
    peStatus: "NotApplicable",
    metadata: {
      ApiType: "Azure",
      ResourceId: fn.resourceId(
        "Microsoft.Storage/storageAccounts",
        storageAccountName,
      ) as any,
    },
  } as any,
});

new ProjectConnection(project, {
  name: "qabot-agent-appinsights",
  properties: {
    authType: "ApiKey",
    category: "AppInsights",
    target: appInsights.id as any,
    credentials: {
      key: appInsights.properties.ConnectionString as any,
    },
    isSharedToAll: true,
    metadata: {
      ApiType: "Azure",
      ResourceId: appInsights.id as any,
    },
  } as any,
});

grantRole(account, {
  role: cognitiveServicesOpenAIUserRoleId,
  principalId: managedIdentityPrincipalId,
  principalType: "ServicePrincipal",
});

const developerCondition = fn.not(fn.empty(developerGroupObjectId));
for (const roleId of [
  cognitiveServicesOpenAIUserRoleId,
  foundryProjectManagerRoleId,
]) {
  new RoleAssignment(
    account,
    {
      name: fn.guid(
        account.id,
        developerGroupObjectId,
        fn.subscriptionResourceId(
          "Microsoft.Authorization/roleDefinitions",
          roleId,
        ),
      ),
      properties: {
        roleDefinitionId: fn.subscriptionResourceId(
          "Microsoft.Authorization/roleDefinitions",
          roleId,
        ),
        principalId: developerGroupObjectId,
        principalType: developerPrincipalType as any,
      },
    },
    { condition: developerCondition },
  );
}

const registry = new Registry(stack, {
  name: containerRegistryName,
  existing: true,
});
new RoleAssignment(registry, {
  name: fn.guid(
    registry.id,
    project.id,
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      acrPullRoleId,
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      acrPullRoleId,
    ),
    principalId: project.identity.principalId as any,
    principalType: "ServicePrincipal",
  },
});

stack.outputs.add("AI_RESOURCE_NAME", "string", account.name);
stack.outputs.add("AI_PROJECT_NAME", "string", project.name);
stack.outputs.add("AZURE_AI_PROJECT_ID", "string", project.id);
stack.outputs.add(
  "FOUNDRY_PROJECT_ENDPOINT",
  "string",
  fn.concat(
    "https://",
    account.name,
    ".services.ai.azure.com/api/projects/",
    project.name,
  ),
);
stack.outputs.add(
  "APPLICATIONINSIGHTS_CONNECTION_STRING",
  "string",
  appInsights.properties.ConnectionString as any,
);
stack.outputs.add("BOT_IDENTITY_NAME", "string", botIdentity.name);
stack.outputs.add(
  "BOT_IDENTITY_PRINCIPAL_ID",
  "string",
  botIdentity.properties.principalId as any,
);
stack.outputs.add("BOT_ID", "string", botIdentity.properties.clientId as any);
stack.outputs.add(
  "BOT_TENANT_ID",
  "string",
  botIdentity.properties.tenantId as any,
);

const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable(
      "AZURE_AI_DEPLOYMENTS_LOCATION",
      fn.readEnvironmentVariable(
        "AZURE_AI_LOCATION",
        fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
      ),
    ),
    botIdentityLocation: fn.readEnvironmentVariable(
      "AZURE_LOCATION",
      "westus2",
    ),
    botIdentityName: fn.readEnvironmentVariable(
      "BOT_IDENTITY_NAME",
      fn.readEnvironmentVariable("FRONTEND_SITE_NAME", ""),
    ),
    managedIdentityPrincipalId: fn.readEnvironmentVariable(
      "MANAGED_IDENTITY_PRINCIPAL_ID",
    ),
    storageAccountName: fn.readEnvironmentVariable("STORAGE_ACCOUNT_NAME"),
    storageBlobEndpoint: fn.readEnvironmentVariable("STORAGE_BLOB_ENDPOINT"),
    containerRegistryName: fn.readEnvironmentVariable(
      "CONTAINER_REGISTRY_NAME",
    ),
    developerGroupObjectId: fn.readEnvironmentVariable(
      "DEVELOPER_PRINCIPAL_ID",
      "",
    ),
    developerPrincipalType: fn.readEnvironmentVariable(
      "DEVELOPER_PRINCIPAL_TYPE",
      "User",
    ),
    agentLogWorkspaceName: fn.readEnvironmentVariable(
      "AGENT_LOG_WORKSPACE_NAME",
      "",
    ),
    agentAppInsightsName: fn.readEnvironmentVariable(
      "AGENT_APP_INSIGHTS_NAME",
      "",
    ),
    aiResourceName: fn.readEnvironmentVariable("AI_RESOURCE_NAME", ""),
    aiProjectName: fn.readEnvironmentVariable("AI_PROJECT_NAME", ""),
  },
});

export const outputJson = serialize([stack]);
const [renderedStack] = renderBicepFiles(outputJson);
if (renderedStack === undefined) {
  throw new Error("Agent provisioning produced no Bicep entry file.");
}
export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];