import {
  bicepRef,
  createBicepParameterFile,
  renderBicepFile,
  renderBicepFiles,
} from "@azure/provisioning-bicep";
import {
  fn,
  Stack,
  type ExpressionOrValue,
} from "@azure/provisioning-core";
import { serialize } from "@azure/provisioning-serialization";
import { Workspace } from "@azure/provisioning-operationalinsights";
import { ApplicationInsightsComponent } from "@azure/provisioning-applicationinsights";
import { AppServicePlan, Site } from "@azure/provisioning-appservice";

const stack = new Stack("main", { targetScope: "resourceGroup" });

function stringParameter(
  name: string,
  options?: { defaultValue?: ExpressionOrValue<string> },
) {
  return stack.parameters.add(name, "string", options);
}

const location = stringParameter("location");
const containerImage = stringParameter("containerImage");
const managedIdentityClientId = stringParameter("managedIdentityClientId");
const managedIdentityResourceId = stringParameter("managedIdentityResourceId");
const storageAccountName = stringParameter("storageAccountName");
const keyVaultName = stringParameter("keyVaultName");
const appConfigName = stringParameter("appConfigName");
const functionAppServicePlanNameOverride = stringParameter(
  "functionAppServicePlanName",
  { defaultValue: "" },
);
const functionLogWorkspaceNameOverride = stringParameter(
  "functionLogWorkspaceName",
  { defaultValue: "" },
);
const functionAppNameOverride = stringParameter("functionAppName", {
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
const functionAppServicePlanName = effective(
  functionAppServicePlanNameOverride,
  fn.concat("azuresdkqabot-functionserviceplan-", suffix),
);
const functionLogWorkspaceName = effective(
  functionLogWorkspaceNameOverride,
  fn.concat("azuresdkqabot-function-log-", suffix),
);
const functionAppName = effective(
  functionAppNameOverride,
  fn.concat("azuresdkqabot-function-", suffix),
);

const serverfarm = new AppServicePlan(stack, {
  name: functionAppServicePlanName,
  location,
  properties: {
    elasticScaleEnabled: true,
    maximumElasticWorkerCount: 20,
    reserved: true,
  } as any,
  sku: {
    name: "EP1",
    tier: "ElasticPremium",
    size: "EP1",
    family: "EP",
    capacity: 1,
  },
  kind: "elastic",
});

const workspace = new Workspace(stack, {
  name: functionLogWorkspaceName,
  location,
  properties: {
    sku: { name: "PerGB2018" },
    retentionInDays: 30,
  },
} as any);

const appInsights = new ApplicationInsightsComponent(stack, {
  name: functionAppName,
  location,
  kind: "web",
  properties: {
    Application_Type: "web",
    RetentionInDays: 90,
    WorkspaceResourceId: workspace.id as any,
  },
});

const site = new Site(stack, {
  name: functionAppName,
  location,
  tags: {
    "hidden-link: /app-insights-resource-id": appInsights.id as any,
    "azd-service-name": "function-app",
  },
  properties: {
    httpsOnly: true,
    publicNetworkAccess: "Enabled",
    serverFarmId: serverfarm.id as any,
    siteConfig: {
      linuxFxVersion: fn.concat("DOCKER|", containerImage) as any,
      alwaysOn: false,
      acrUseManagedIdentityCreds: true,
      acrUserManagedIdentityID: managedIdentityClientId,
      ftpsState: "FtpsOnly",
      httpLoggingEnabled: false,
      minTlsVersion: "1.2",
      appSettings: [
        { name: "AZURE_CLIENT_ID", value: managedIdentityClientId },
        { name: "AZURE_TENANT_ID", value: fn.tenant().tenantId as any },
        {
          name: "AZURE_SUBSCRIPTION_ID",
          value: fn.subscription().subscriptionId as any,
        },
        { name: "STORAGE_ACCOUNT_NAME", value: storageAccountName },
        { name: "KEY_VAULT_NAME", value: keyVaultName },
        {
          name: "KEY_VAULT_URL",
          value: fn.concat(
            "https://",
            keyVaultName,
            (fn.environment() as any).suffixes.keyvaultDns,
          ),
        },
        {
          name: "ADO_RESOURCE_SCOPE",
          value: "499b84ac-1321-427f-aa17-267ca6975798/.default",
        },
        { name: "APP_CONFIG_NAME", value: appConfigName },
        {
          name: "APPINSIGHTS_INSTRUMENTATIONKEY",
          value: appInsights.properties.InstrumentationKey as any,
        },
        {
          name: "APPLICATIONINSIGHTS_CONNECTION_STRING",
          value: appInsights.properties.ConnectionString as any,
        },
        {
          name: "AzureWebJobsStorage__accountName",
          value: storageAccountName,
        },
        {
          name: "AzureWebJobsStorage__credential",
          value: "managedidentity",
        },
        {
          name: "AzureWebJobsStorage__clientId",
          value: managedIdentityClientId,
        },
        {
          name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE",
          value: "false",
        },
        { name: "FUNCTIONS_WORKER_RUNTIME", value: "node" },
        { name: "FUNCTIONS_EXTENSION_VERSION", value: "~4" },
      ],
      cors: {
        allowedOrigins: ["https://portal.azure.com"],
        supportCredentials: false,
      },
    },
  } as any,
  identity: {
    type: "UserAssigned",
    userAssignedIdentities: fn.json(
      fn.concat('{"', managedIdentityResourceId, '":{}}'),
    ) as any,
  },
  kind: "functionapp,linux,container",
});

stack.outputs.add("FUNCTION_APP_NAME", "string", site.name);

const env = bicepRef<string>("env");
const deployedFunctionImage = bicepRef<string>("deployedFunctionImage");
const registryEndpoint = bicepRef<string>("registryEndpoint");
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  variables: {
    env: fn.readEnvironmentVariable("AZURE_ENV_NAME", "dev"),
    deployedFunctionImage: fn.readEnvironmentVariable(
      "SERVICE_FUNCTION_APP_IMAGE_NAME",
      "",
    ),
    registryEndpoint: fn.readEnvironmentVariable(
      "AZURE_CONTAINER_REGISTRY_ENDPOINT",
    ),
  },
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    containerImage: fn.cond(
      fn.not(fn.empty(deployedFunctionImage)),
      deployedFunctionImage,
      fn.concat(
        registryEndpoint,
        "/",
        fn.readEnvironmentVariable(
          "FUNCTION_IMAGE_REPOSITORY",
          fn.concat("azure-sdk-qa-bot-function:", env),
        ),
      ),
    ),
    managedIdentityClientId: fn.readEnvironmentVariable(
      "MANAGED_IDENTITY_CLIENT_ID",
    ),
    managedIdentityResourceId: fn.readEnvironmentVariable(
      "MANAGED_IDENTITY_RESOURCE_ID",
    ),
    storageAccountName: fn.readEnvironmentVariable("STORAGE_ACCOUNT_NAME"),
    keyVaultName: fn.readEnvironmentVariable("KEY_VAULT_NAME"),
    appConfigName: fn.readEnvironmentVariable("APP_CONFIG_NAME"),
    functionAppServicePlanName: fn.readEnvironmentVariable(
      "FUNCTION_APP_SERVICE_PLAN_NAME",
      "",
    ),
    functionLogWorkspaceName: fn.readEnvironmentVariable(
      "FUNCTION_LOG_WORKSPACE_NAME",
      "",
    ),
    functionAppName: fn.readEnvironmentVariable("FUNCTION_APP_NAME", ""),
  },
});

export const outputJson = serialize([stack]);
const [renderedStack] = renderBicepFiles(outputJson);
if (renderedStack === undefined) {
  throw new Error("Function App provisioning produced no Bicep entry file.");
}
export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepFile(parameterFile),
];