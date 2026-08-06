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
import { UserAssignedIdentity } from "@azure/provisioning-managed-identity";
import { Workspace } from "@azure/provisioning-operationalinsights";
import {
  ApplicationInsightsComponent,
  WebTest,
} from "@azure/provisioning-applicationinsights";
import {
  ActionGroup,
  DiagnosticSetting,
  MetricAlert,
} from "@azure/provisioning-monitor";
import { Registry } from "@azure/provisioning-container-registry";
import { AppServicePlan, Site } from "@azure/provisioning-appservice";
import { Bot, Channel } from "@azure/provisioning-botservice";
import { StorageAccount } from "@azure/provisioning-storage";
import {
  grantRole,
  ManagementLock,
  Role,
  RoleAssignment,
} from "@azure/provisioning-authorization";

const stack = new Stack("main", { targetScope: "resourceGroup" });

function stringParameter(
  name: string,
  options?: { defaultValue?: ExpressionOrValue<string> },
) {
  return stack.parameters.add(name, "string", options);
}

const location = stringParameter("location", { defaultValue: "westus2" });
const envName = stringParameter("envName", { defaultValue: "dev" });
const storageAccountName = stringParameter("storageAccountName");
const containerRegistryName = stringParameter("containerRegistryName");
const frontendImageRepository = stringParameter("frontendImageRepository");
const serverAudience = stringParameter("serverAudience");
const ragServiceScope = stringParameter("ragServiceScope");
const botIdentityName = stringParameter("botIdentityName");
const frontendBaseNameOverride = stringParameter("frontendBaseName", {
  defaultValue: "",
});
const frontendAppInsightsNameOverride = stringParameter(
  "frontendAppInsightsName",
  { defaultValue: "" },
);
const frontendEmailActionGroupNameOverride = stringParameter(
  "frontendEmailActionGroupName",
  { defaultValue: "" },
);
const frontendDiagnosticSettingNameOverride = stringParameter(
  "frontendDiagnosticSettingName",
  { defaultValue: "" },
);
const frontendHealthTestNameOverride = stringParameter(
  "frontendHealthTestName",
  { defaultValue: "" },
);
const frontendServerErrorsAlertNameOverride = stringParameter(
  "frontendServerErrorsAlertName",
  { defaultValue: "" },
);
const frontendHealthCheckAlertNameOverride = stringParameter(
  "frontendHealthCheckAlertName",
  { defaultValue: "" },
);
const frontendDeleteLockNameOverride = stringParameter(
  "frontendDeleteLockName",
  { defaultValue: "" },
);
const azureTableNameForConversationOverride = stringParameter(
  "azureTableNameForConversation",
  { defaultValue: "" },
);
const teamsBotFullDisplayNameOverride = stringParameter(
  "teamsBotFullDisplayName",
  { defaultValue: "" },
);
const githubAppId = stringParameter("githubAppId", {
  defaultValue: "1086291",
});
const githubAppKeyVaultName = stringParameter("githubAppKeyVaultName", {
  defaultValue: "azuresdkengkeyvault",
});
const githubAppKeyName = stringParameter("githubAppKeyName", {
  defaultValue: "azure-sdk-automation",
});
const githubAppInstallOwner = stringParameter("githubAppInstallOwner", {
  defaultValue: "Azure",
});

const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);
const envSuffixTitleCase = stack.variables.add(
  "envSuffixTitleCase",
  fn.concat(fn.toUpper(fn.substring(envName, 0, 1)), fn.substring(envName, 1)),
);
const effective = (
  override: ExpressionOrValue<string>,
  fallback: ExpressionOrValue<string>,
) => fn.cond(fn.not(fn.empty(override)), override, fallback);
const suffixed = (prefix: string) => fn.concat(prefix, suffix);
const frontendBaseName = effective(
  frontendBaseNameOverride,
  suffixed("azsdkqabot-"),
);
const frontendAppInsightsName = effective(
  frontendAppInsightsNameOverride,
  suffixed("azsdkqabot-insights-"),
);
const frontendEmailActionGroupName = effective(
  frontendEmailActionGroupNameOverride,
  suffixed("azsdkqabot-email-alerts-"),
);
const frontendDiagnosticSettingName = effective(
  frontendDiagnosticSettingNameOverride,
  suffixed("azsdkqabot-diagnostic-"),
);
const frontendHealthTestName = effective(
  frontendHealthTestNameOverride,
  suffixed("azsdkqabot-health-test-"),
);
const frontendServerErrorsAlertName = effective(
  frontendServerErrorsAlertNameOverride,
  suffixed("azsdkqabot-server-errors-"),
);
const frontendHealthCheckAlertName = effective(
  frontendHealthCheckAlertNameOverride,
  suffixed("azsdkqabot-health-check-failure-"),
);
const frontendDeleteLockName = effective(
  frontendDeleteLockNameOverride,
  suffixed("azsdkqabot-delete-lock-"),
);
const azureTableNameForConversation = effective(
  azureTableNameForConversationOverride,
  fn.concat("TeamsChannelConversations", envSuffixTitleCase),
);
const teamsBotFullDisplayName = effective(
  teamsBotFullDisplayNameOverride,
  fn.cond(
    fn.eq(envName, "prod"),
    "Azure SDK Q&A Bot",
    fn.concat("Azure SDK Q&A Bot ", envName),
  ),
);

const identity = new UserAssignedIdentity(stack, {
  name: botIdentityName,
  existing: true,
});
const botIdentityResourceId = stack.variables.add(
  "botIdentityResourceId",
  identity.id,
);

const sharedStorageAccount = new StorageAccount(stack, {
  name: storageAccountName,
  existing: true,
});
for (const role of [
  Role.StorageAccountContributor,
  Role.StorageBlobDataContributor,
  Role.StorageTableDataContributor,
]) {
  grantRole(sharedStorageAccount, {
    role,
    principalId: identity.properties.principalId as any,
    principalKey: identity.id,
    principalType: "ServicePrincipal",
  });
}

const workspace = new Workspace(stack, {
  name: frontendBaseName,
  location,
  properties: {
    sku: { name: "PerGB2018" },
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true,
    } as any,
    workspaceCapping: {
      dailyQuotaGb: -1,
    },
    publicNetworkAccessForIngestion: "Enabled",
    publicNetworkAccessForQuery: "Enabled",
  },
});

const appInsights = new ApplicationInsightsComponent(stack, {
  name: frontendAppInsightsName,
  location,
  kind: "web",
  properties: {
    Application_Type: "web",
    RetentionInDays: 90,
    WorkspaceResourceId: workspace.id as any,
  },
});

new RoleAssignment(appInsights, {
  name: fn.guid(
    appInsights.id,
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      Role.MonitoringMetricsPublisher,
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      Role.MonitoringMetricsPublisher,
    ),
    principalId: identity.properties.principalId as any,
    principalType: "ServicePrincipal",
  },
});

const actionGroup = new ActionGroup(stack, {
  name: frontendEmailActionGroupName,
  location: "Global",
  properties: {
    groupShortName: "EmailAlerts",
    enabled: true,
    emailReceivers: [
      {
        name: "email-0",
        emailAddress: "chunyu@microsoft.com",
        useCommonAlertSchema: true,
      },
      {
        name: "email-1",
        emailAddress: "jiaqzhang@microsoft.com",
        useCommonAlertSchema: true,
      },
      {
        name: "email-2",
        emailAddress: "Renhe.Li@microsoft.com",
        useCommonAlertSchema: true,
      },
      {
        name: "email-3",
        emailAddress: "jialinhuang@microsoft.com",
        useCommonAlertSchema: true,
      },
    ],
  } as any,
});

const sharedRegistry = new Registry(stack, {
  name: containerRegistryName,
  existing: true,
});
new RoleAssignment(sharedRegistry, {
  name: fn.guid(
    sharedRegistry.id,
    identity.id,
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      Role.AcrPull,
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      Role.AcrPull,
    ),
    principalId: identity.properties.principalId as any,
    principalType: "ServicePrincipal",
  },
});

const serverfarm = new AppServicePlan(stack, {
  name: frontendBaseName,
  location,
  properties: {
    reserved: true,
  },
  sku: {
    name: "B3",
    tier: "Basic",
    size: "B3",
    family: "B",
    capacity: 1,
  },
  kind: "linux",
});

const site = new Site(stack, {
  name: frontendBaseName,
  location,
  tags: {
    "azd-service-name": "frontend",
    "hidden-link: /app-insights-resource-id": appInsights.id as any,
  },
  properties: {
    httpsOnly: true,
    publicNetworkAccess: "Enabled",
    serverFarmId: serverfarm.id as any,
    siteConfig: {
      linuxFxVersion: fn.concat(
        "DOCKER|",
        sharedRegistry.properties.loginServer as any,
        "/",
        frontendImageRepository,
      ) as any,
      alwaysOn: true,
      acrUseManagedIdentityCreds: true,
      acrUserManagedIdentityID: identity.properties.clientId as any,
      ftpsState: "FtpsOnly",
      httpLoggingEnabled: true,
      minTlsVersion: "1.2",
      healthCheckPath: "/health",
      appSettings: [
        { name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE", value: "false" },
        { name: "WEBSITES_PORT", value: "3978" },
        { name: "RUNNING_ON_AZURE", value: "1" },
        { name: "BOT_ID", value: identity.properties.clientId as any },
        { name: "BOT_TENANT_ID", value: identity.properties.tenantId as any },
        { name: "BOT_TYPE", value: "UserAssignedMsi" },
        { name: "AZURE_CLIENT_ID", value: identity.properties.clientId as any },
        { name: "SERVER_AUDIENCE", value: serverAudience },
        { name: "RAG_SERVICE_SCOPE", value: ragServiceScope },
        { name: "STORAGE_ACCOUNT_NAME", value: storageAccountName },
        {
          name: "AZURE_TABLE_NAME_FOR_CONVERSATION",
          value: azureTableNameForConversation,
        },
        { name: "BLOB_CONTAINER_NAME", value: "bot-configs" },
        { name: "CHANNEL_CONFIG_BLOB_NAME", value: "channel.yaml" },
        { name: "TENANT_CONFIG_BLOB_NAME", value: "tenant.yaml" },
        { name: "GITHUB_APP_ID", value: githubAppId },
        { name: "GITHUB_APP_KEY_VAULT_NAME", value: githubAppKeyVaultName },
        { name: "GITHUB_APP_KEY_NAME", value: githubAppKeyName },
        { name: "GITHUB_APP_INSTALL_OWNER", value: githubAppInstallOwner },
        { name: "TEAMS_BOT_FULL_DISPLAY_NAME", value: teamsBotFullDisplayName },
      ],
    },
  } as any,
  identity: {
    type: "UserAssigned",
    userAssignedIdentities: fn.json(
      fn.concat('{"', botIdentityResourceId, '":{}}'),
    ) as any,
  },
  kind: "app,linux,container",
});

new DiagnosticSetting(site, {
  name: frontendDiagnosticSettingName,
  properties: {
    workspaceId: workspace.id as any,
    logs: [
      { category: "AppServiceHTTPLogs", enabled: true },
      { category: "AppServiceConsoleLogs", enabled: true },
      { category: "AppServiceAppLogs", enabled: true },
      { category: "AppServiceAuditLogs", enabled: true },
      { category: "AppServicePlatformLogs", enabled: true },
    ],
    metrics: [{ timeGrain: "PT1M", enabled: true }],
  } as any,
});

const botService = new Bot(stack, {
  name: frontendBaseName,
  location: "global",
  sku: { name: "F0" },
  kind: "azurebot",
  properties: {
    displayName: teamsBotFullDisplayName as any,
    endpoint: fn.concat(
      "https://",
      site.properties.defaultHostName as any,
      "/api/messages",
    ),
    msaAppId: identity.properties.clientId as any,
    msaAppTenantId: identity.properties.tenantId as any,
    msaAppType: "UserAssignedMSI",
    msaAppMSIResourceId: identity.id as any,
  },
});

new Channel(botService, {
  name: "MsTeamsChannel",
  location: "global",
  properties: {
    channelName: "MsTeamsChannel",
    location: "global",
  } as any,
});

new WebTest(stack, {
  name: frontendHealthTestName,
  location,
  tags: fn.json(
    fn.concat('{"hidden-link:', appInsights.id, '":"Resource"}'),
  ) as any,
  kind: "ping",
  properties: {
    SyntheticMonitorId: frontendHealthTestName as any,
    Name: "azsdkqabot Health Check Test",
    Description: "Health check test to monitor server availability",
    Enabled: true,
    Frequency: 300,
    Timeout: 30,
    Kind: "ping",
    RetryEnabled: true,
    Locations: [
      { Id: "us-tx-sn1-azr" },
      { Id: "us-il-ch1-azr" },
      { Id: "us-ca-sjc-azr" },
      { Id: "us-va-ash-azr" },
      { Id: "emea-nl-ams-azr" },
    ],
    Configuration: {
      WebTest:
        '<WebTest Name="azsdkqabot Health Check Test" Id="ABD48585-0831-40CB-9069-682EA6BB3584" Enabled="True" CssProjectStructure="" CssIteration="" Timeout="30" WorkItemIds="" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010" Description="" CredentialUserName="" CredentialPassword="" PreAuthenticate="True" Proxy="default" StopOnError="False" RecordedResultFile="" ResultsLocale=""><Items><Request Method="GET" Guid="a5f10126-e4cd-570d-961c-cea43999a201" Version="1.1" Url="https://azsdkqabot.azurewebsites.net/health" ThinkTime="0" Timeout="30" ParseDependentRequests="False" FollowRedirects="True" RecordResult="True" Cache="False" ResponseTimeGoal="0" Encoding="utf-8" ExpectedHttpStatusCode="200" ExpectedResponseUrl="" ReportingName="" IgnoreHttpStatusCode="False" /></Items></WebTest>',
    },
  } as any,
});

new MetricAlert(stack, {
  name: frontendServerErrorsAlertName,
  location: "Global",
  properties: {
    description: "Alert when server returns 5xx HTTP errors",
    severity: 3,
    enabled: true,
    scopes: [site.id as any],
    evaluationFrequency: "PT1M",
    actions: [{ actionGroupId: actionGroup.id as any }],
    windowSize: "PT5M",
    criteria: {
      allOf: [
        {
          operator: "GreaterThan",
          threshold: 0,
          name: "Http5xxCriteria",
          metricNamespace: "Microsoft.Web/sites",
          metricName: "Http5xx",
          dimensions: [],
          timeAggregation: "Total",
          criterionType: "StaticThresholdCriterion",
        },
      ],
      "odata.type":
        "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",
    } as any,
  },
});

new MetricAlert(stack, {
  name: frontendHealthCheckAlertName,
  location: "Global",
  properties: {
    description:
      "Alert when health check fails (server is down or not responding)",
    severity: 3,
    enabled: true,
    scopes: [site.id as any],
    evaluationFrequency: "PT1M",
    actions: [{ actionGroupId: actionGroup.id as any }],
    windowSize: "PT5M",
    criteria: {
      allOf: [
        {
          name: "HealthCheckFailedCriteria",
          metricNamespace: "Microsoft.Web/sites",
          metricName: "HealthCheckStatus",
          dimensions: [],
          timeAggregation: "Average",
          operator: "LessThan",
          threshold: 100,
          criterionType: "StaticThresholdCriterion",
        },
      ],
      "odata.type":
        "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",
    } as any,
  },
});

new ManagementLock(stack, {
  name: frontendDeleteLockName,
  properties: {
    level: "CanNotDelete",
    notes:
      "This resource group is protected from deletion. Contact the Azure SDK team if you need to remove it.",
  },
});

stack.outputs.add(
  "BOT_BASE_URL",
  "string",
  fn.concat("https://", site.properties.defaultHostName as any),
);
stack.outputs.add(
  "BOT_AUDIENCE",
  "string",
  "https://api.botframework.com",
);
stack.outputs.add("BOT_AZURE_APP_SERVICE_RESOURCE_ID", "string", site.id);
stack.outputs.add(
  "BOT_DOMAIN",
  "string",
  site.properties.defaultHostName as any,
);
stack.outputs.add("FRONTEND_SITE_NAME", "string", site.name);

const env = bicepRef<string>("env");
const deployedFrontendImage = bicepRef<string>("deployedFrontendImage");
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  variables: {
    env: fn.readEnvironmentVariable("AZURE_ENV_NAME", "dev"),
    deployedFrontendImage: fn.readEnvironmentVariable(
      "SERVICE_FRONTEND_IMAGE_NAME",
      "",
    ),
  },
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    envName: env,
    storageAccountName: fn.readEnvironmentVariable("STORAGE_ACCOUNT_NAME"),
    containerRegistryName: fn.readEnvironmentVariable(
      "CONTAINER_REGISTRY_NAME",
    ),
    frontendImageRepository: fn.cond(
      fn.not(fn.empty(deployedFrontendImage)),
      fn.last(fn.split(deployedFrontendImage, "/")),
      fn.readEnvironmentVariable(
        "FRONTEND_IMAGE_REPOSITORY",
        fn.concat("azure-sdk-qa-bot:", env),
      ),
    ),
    serverAudience: fn.readEnvironmentVariable("SERVER_AUDIENCE"),
    ragServiceScope: fn.readEnvironmentVariable("RAG_SERVICE_SCOPE"),
    botIdentityName: fn.readEnvironmentVariable("BOT_IDENTITY_NAME"),
    frontendBaseName: fn.readEnvironmentVariable("FRONTEND_SITE_NAME", ""),
    frontendAppInsightsName: fn.readEnvironmentVariable(
      "FRONTEND_APP_INSIGHTS_NAME",
      "",
    ),
    frontendEmailActionGroupName: fn.readEnvironmentVariable(
      "FRONTEND_EMAIL_ACTION_GROUP_NAME",
      "",
    ),
    frontendDiagnosticSettingName: fn.readEnvironmentVariable(
      "FRONTEND_DIAGNOSTIC_SETTING_NAME",
      "",
    ),
    frontendHealthTestName: fn.readEnvironmentVariable(
      "FRONTEND_HEALTH_TEST_NAME",
      "",
    ),
    frontendServerErrorsAlertName: fn.readEnvironmentVariable(
      "FRONTEND_SERVER_ERRORS_ALERT_NAME",
      "",
    ),
    frontendHealthCheckAlertName: fn.readEnvironmentVariable(
      "FRONTEND_HEALTH_CHECK_ALERT_NAME",
      "",
    ),
    frontendDeleteLockName: fn.readEnvironmentVariable(
      "FRONTEND_DELETE_LOCK_NAME",
      "",
    ),
    azureTableNameForConversation: fn.readEnvironmentVariable(
      "AZURE_TABLE_NAME_FOR_CONVERSATION",
      "",
    ),
    teamsBotFullDisplayName: fn.readEnvironmentVariable(
      "TEAMS_BOT_FULL_DISPLAY_NAME",
      "",
    ),
    githubAppId: fn.readEnvironmentVariable("GITHUB_APP_ID", "1086291"),
    githubAppKeyVaultName: fn.readEnvironmentVariable(
      "GITHUB_APP_KEY_VAULT_NAME",
      "azuresdkengkeyvault",
    ),
    githubAppKeyName: fn.readEnvironmentVariable(
      "GITHUB_APP_KEY_NAME",
      "azure-sdk-automation",
    ),
    githubAppInstallOwner: fn.readEnvironmentVariable(
      "GITHUB_APP_INSTALL_OWNER",
      "Azure",
    ),
  },
});

export const outputJson = serialize([stack]);
const [renderedStack] = renderBicepFiles(outputJson);
if (renderedStack === undefined) {
  throw new Error("Frontend provisioning produced no Bicep entry file.");
}
export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepFile(parameterFile),
];