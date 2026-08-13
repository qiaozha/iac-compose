import {
  bicepRef,
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
import { Workspace } from "@azure/provisioning-operationalinsights";
import { ApplicationInsightsComponent } from "@azure/provisioning-applicationinsights";
import {
  AppServicePlan,
  Site,
  SiteConfigAuthsettingsV2,
} from "@azure/provisioning-appservice";
import { MetricAlert } from "@azure/provisioning-monitor";

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
const serverAudience = stringParameter("serverAudience");
const sharedIdentityName = stringParameter("sharedIdentityName");
const frontendIdentityName = stringParameter("frontendIdentityName");
const aiResourceName = stringParameter("aiResourceName");
const aiProjectName = stringParameter("aiProjectName");
const cosmosDbAccountName = stringParameter("cosmosDbAccountName");
const storageAccountName = stringParameter("storageAccountName");
const appConfigName = stringParameter("appConfigName");
const actionGroupName = stringParameter("actionGroupName");
const agentServerAppServicePlanNameOverride = stringParameter(
  "agentServerAppServicePlanName",
  { defaultValue: "" },
);
const agentServerLogWorkspaceNameOverride = stringParameter(
  "agentServerLogWorkspaceName",
  { defaultValue: "" },
);
const agentServerSiteNameOverride = stringParameter("agentServerSiteName", {
  defaultValue: "",
});
const agentServerAppInsightsNameOverride = stringParameter(
  "agentServerAppInsightsName",
  { defaultValue: "" },
);
const agentServerAlertNameOverride = stringParameter("agentServerAlertName", {
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
const agentServerAppServicePlanName = effective(
  agentServerAppServicePlanNameOverride,
  suffixed("azuresdkqabot-appserviceplan-"),
);
const agentServerLogWorkspaceName = effective(
  agentServerLogWorkspaceNameOverride,
  suffixed("azuresdkqabot-log-"),
);
const agentServerSiteName = effective(
  agentServerSiteNameOverride,
  suffixed("azuresdkqabot-server-"),
);
const agentServerAppInsightsName = effective(
  agentServerAppInsightsNameOverride,
  suffixed("azuresdkqabot-server202510300250-"),
);
const agentServerAlertName = effective(
  agentServerAlertNameOverride,
  suffixed("azuresdkqabot-alert-"),
);

const sharedIdentityResourceId = stack.variables.add(
  "sharedIdentityResourceId",
  fn.resourceId(
    "Microsoft.ManagedIdentity/userAssignedIdentities",
    sharedIdentityName,
  ),
);
const frontendIdentityResourceId = stack.variables.add(
  "frontendIdentityResourceId",
  fn.resourceId(
    "Microsoft.ManagedIdentity/userAssignedIdentities",
    frontendIdentityName,
  ),
);

const serverfarm = new AppServicePlan(stack, {
  name: agentServerAppServicePlanName,
  location,
  properties: {
    reserved: true,
  },
  sku: {
    name: "P0v3",
    tier: "Premium0V3",
    size: "P0v3",
    family: "Pv3",
    capacity: 1,
  },
  kind: "linux",
});

const workspace = new Workspace(stack, {
  name: agentServerLogWorkspaceName,
  location,
  properties: {
    sku: { name: "PerGB2018" },
    publicNetworkAccessForIngestion: "Enabled",
    publicNetworkAccessForQuery: "Enabled",
  },
});

const appInsights = new ApplicationInsightsComponent(stack, {
  name: agentServerAppInsightsName,
  location,
  kind: "web",
  properties: {
    Application_Type: "web",
    RetentionInDays: 90,
    WorkspaceResourceId: workspace.id as any,
  },
});

const site = new Site(stack, {
  name: agentServerSiteName,
  location,
  tags: {
    "hidden-link: /app-insights-resource-id": appInsights.id as any,
    "azd-service-name": "agent-server",
  },
  properties: {
    httpsOnly: true,
    publicNetworkAccess: "Enabled",
    serverFarmId: serverfarm.id as any,
    siteConfig: {
      linuxFxVersion: fn.concat("DOCKER|", containerImage) as any,
      alwaysOn: true,
      acrUseManagedIdentityCreds: true,
      acrUserManagedIdentityID: managedIdentityClientId,
      ftpsState: "FtpsOnly",
      httpLoggingEnabled: false,
      minTlsVersion: "1.2",
      appSettings: [
        { name: "WEBSITES_PORT", value: "8089" },
        { name: "AZURE_CLIENT_ID", value: managedIdentityClientId },
        { name: "AZURE_TENANT_ID", value: fn.tenant().tenantId as any },
        {
          name: "AZURE_SUBSCRIPTION_ID",
          value: fn.subscription().subscriptionId as any,
        },
        {
          name: "AZURE_RESOURCE_GROUP",
          value: fn.resourceGroup().name as any,
        },
        { name: "AI_PROJECT_NAME", value: aiProjectName },
        { name: "AZURE_AI_RESOURCE_NAME", value: aiResourceName },
        {
          name: "APP_INSIGHTS_CONNECTION_STRING",
          value: appInsights.properties.ConnectionString as any,
        },
        { name: "COSMOS_DB_ACCOUNT_NAME", value: cosmosDbAccountName },
        { name: "STORAGE_ACCOUNT_NAME", value: storageAccountName },
        {
          name: "AZURE_APPCONFIG_ENDPOINT",
          value: fn.concat("https://", appConfigName, ".azconfig.io"),
        },
      ],
    },
  } as any,
  identity: {
    type: "UserAssigned",
    userAssignedIdentities: fn.union(
      fn.json(fn.concat('{"', sharedIdentityResourceId, '":{}}')),
      fn.json(fn.concat('{"', frontendIdentityResourceId, '":{}}')),
    ) as any,
  },
  kind: "app,linux,container",
});

new SiteConfigAuthsettingsV2(site, {
  properties: {
    platform: {
      enabled: true,
      runtimeVersion: "~1",
    },
    globalValidation: {
      requireAuthentication: true,
      unauthenticatedClientAction: "RedirectToLoginPage",
      excludedPaths: ["/ping"],
    },
    identityProviders: {
      azureActiveDirectory: {
        enabled: true,
        registration: {
          clientId: serverAudience,
          openIdIssuer: fn.concat(
            (fn.environment() as any).authentication.loginEndpoint,
            fn.tenant().tenantId,
            "/v2.0",
          ) as any,
        },
        login: {
          loginParameters: [],
        },
      },
    },
    login: {
      tokenStore: {
        enabled: true,
      },
    },
  } as any,
});

new MetricAlert(stack, {
  name: agentServerAlertName,
  location: "global",
  properties: {
    severity: 3,
    enabled: true,
    scopes: [site.id as any],
    evaluationFrequency: "PT1M",
    autoMitigate: true,
    targetResourceType: "Microsoft.Web/sites",
    targetResourceRegion: location,
    actions: [
      {
        actionGroupId: fn.resourceId(
          "Microsoft.Insights/actionGroups",
          actionGroupName,
        ) as any,
        webHookProperties: {},
      },
    ],
    windowSize: "PT5M",
    criteria: {
      allOf: [
        {
          operator: "GreaterThan",
          threshold: 0,
          name: "Metric1",
          metricNamespace: "Microsoft.Web/sites",
          metricName: "Http5xx",
          dimensions: [],
          timeAggregation: "Total",
          skipMetricValidation: false,
          criterionType: "StaticThresholdCriterion",
        },
      ],
      "odata.type":
        "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",
    } as any,
  },
});

stack.outputs.add(
  "SERVER_BASE_URL",
  "string",
  fn.concat("https://", site.properties.defaultHostName as any),
);
stack.outputs.add("AGENT_SERVER_SITE_NAME", "string", site.name);

const env = bicepRef<string>("env");
const deployedAgentServerImage = bicepRef<string>("deployedAgentServerImage");
const registryEndpoint = bicepRef<string>("registryEndpoint");
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  variables: {
    env: fn.readEnvironmentVariable("AZURE_ENV_NAME", "dev"),
    deployedAgentServerImage: fn.readEnvironmentVariable(
      "SERVICE_AGENT_SERVER_IMAGE_NAME",
      "",
    ),
    registryEndpoint: fn.readEnvironmentVariable(
      "AZURE_CONTAINER_REGISTRY_ENDPOINT",
    ),
  },
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    containerImage: fn.cond(
      fn.not(fn.empty(deployedAgentServerImage)),
      deployedAgentServerImage,
      fn.concat(
        registryEndpoint,
        "/",
        fn.readEnvironmentVariable(
          "AGENT_SERVER_IMAGE_REPOSITORY",
          fn.concat("azure-sdk-qa-bot-agent-server:", env),
        ),
      ),
    ),
    managedIdentityClientId: fn.readEnvironmentVariable(
      "MANAGED_IDENTITY_CLIENT_ID",
    ),
    serverAudience: fn.readEnvironmentVariable("SERVER_AUDIENCE"),
    sharedIdentityName: fn.readEnvironmentVariable("MANAGED_IDENTITY_NAME"),
    frontendIdentityName: fn.readEnvironmentVariable("BOT_IDENTITY_NAME"),
    aiResourceName: fn.readEnvironmentVariable("AI_RESOURCE_NAME"),
    aiProjectName: fn.readEnvironmentVariable("AI_PROJECT_NAME"),
    cosmosDbAccountName: fn.readEnvironmentVariable("COSMOSDB_ACCOUNT_NAME"),
    storageAccountName: fn.readEnvironmentVariable("STORAGE_ACCOUNT_NAME"),
    appConfigName: fn.readEnvironmentVariable("APP_CONFIG_NAME"),
    actionGroupName: fn.readEnvironmentVariable("ACTION_GROUP_NAME"),
    agentServerAppServicePlanName: fn.readEnvironmentVariable(
      "AGENT_SERVER_APP_SERVICE_PLAN_NAME",
      "",
    ),
    agentServerLogWorkspaceName: fn.readEnvironmentVariable(
      "AGENT_SERVER_LOG_WORKSPACE_NAME",
      "",
    ),
    agentServerSiteName: fn.readEnvironmentVariable(
      "AGENT_SERVER_SITE_NAME",
      "",
    ),
    agentServerAppInsightsName: fn.readEnvironmentVariable(
      "AGENT_SERVER_APP_INSIGHTS_NAME",
      "",
    ),
    agentServerAlertName: fn.readEnvironmentVariable(
      "AGENT_SERVER_ALERT_NAME",
      "",
    ),
  },
});

export const outputJson = serialize([stack]);
const [renderedStack] = renderBicepFiles(outputJson);
if (renderedStack === undefined) {
  throw new Error("Agent-server provisioning produced no Bicep entry file.");
}
export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];