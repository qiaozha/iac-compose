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
import { ApiConnection } from "@azure/provisioning-appservice";
import {
  IntegrationAccount,
  Workflow,
} from "@azure/provisioning-logic";
import { MetricAlert } from "@azure/provisioning-monitor";
import { createLogicAppWorkflowDefinition } from "./workflow.js";

const stack = new Stack("main", { targetScope: "resourceGroup" });

function stringParameter(name: string): ExpressionOrValue<string> {
  return stack.parameters.add(name, "string");
}

const location = stringParameter("location");
const managedIdentityName = stringParameter("managedIdentityName");
const botIdentityName = stringParameter("botIdentityName");
const integrationAccountNameOverride = stack.parameters.add(
  "integrationAccountName",
  "string",
  { defaultValue: "" },
);
const teamsConnectionNameOverride = stack.parameters.add(
  "teamsConnectionName",
  "string",
  { defaultValue: "" },
);
const azureBlobConnectionNameOverride = stack.parameters.add(
  "azureBlobConnectionName",
  "string",
  { defaultValue: "" },
);
const documentDbConnectionNameOverride = stack.parameters.add(
  "documentDbConnectionName",
  "string",
  { defaultValue: "" },
);
const logicAppWorkflowNameOverride = stack.parameters.add(
  "logicAppWorkflowName",
  "string",
  { defaultValue: "" },
);
const logicAppAlertNameOverride = stack.parameters.add(
  "logicAppAlertName",
  "string",
  { defaultValue: "" },
);
const actionGroupName = stringParameter("actionGroupName");
const functionAppName = stringParameter("functionAppName");
const teamsGroupId = stringParameter("teamsGroupId");
const teamsChannelIds = stringParameter("teamsChannelIds");
const serverBaseUrl = stringParameter("serverBaseUrl");
const serverAudience = stringParameter("serverAudience");
const botBaseUrl = stringParameter("botBaseUrl");
const botAudience = stringParameter("botAudience");
const botId = stringParameter("botId");
const storageAccountName = stringParameter("storageAccountName");
const createTeamsConnection = stack.parameters.add(
  "createTeamsConnection",
  "bool",
);
const deployWorkflow = stack.parameters.add("deployWorkflow", "bool");

const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);
const effective = (
  override: ExpressionOrValue<string>,
  prefix: string,
) => fn.cond(fn.not(fn.empty(override)), override, fn.concat(prefix, suffix));
const integrationAccountName = effective(
  integrationAccountNameOverride,
  "azuresdkqabot-ia-",
);
const teamsConnectionName = effective(teamsConnectionNameOverride, "teams-");
const azureBlobConnectionName = effective(
  azureBlobConnectionNameOverride,
  "azureblob-",
);
const documentDbConnectionName = effective(
  documentDbConnectionNameOverride,
  "documentdb-",
);
const logicAppWorkflowName = effective(
  logicAppWorkflowNameOverride,
  "azuresdkqabot-logicapp-",
);
const logicAppAlertName = effective(
  logicAppAlertNameOverride,
  "azuresdkqabot-logicapp-alert-",
);

const serverIdentityResourceId = stack.variables.add(
  "serverIdentityResourceId",
  fn.resourceId(
    "Microsoft.ManagedIdentity/userAssignedIdentities",
    managedIdentityName,
  ),
);
const botIdentityResourceId = stack.variables.add(
  "botIdentityResourceId",
  fn.resourceId(
    "Microsoft.ManagedIdentity/userAssignedIdentities",
    botIdentityName,
  ),
);
const functionAppResourceId = stack.variables.add(
  "functionAppResourceId",
  fn.resourceId("Microsoft.Web/sites", functionAppName),
);
const managedApiId = (connector: string) =>
  fn.concat(
    "/subscriptions/",
    fn.subscription().subscriptionId,
    "/providers/Microsoft.Web/locations/",
    location,
    "/managedApis/",
    connector,
  );
const connectionResourceId = (name: ExpressionOrValue<string>) =>
  fn.resourceId("Microsoft.Web/connections", name);

const integrationAccount = new IntegrationAccount(stack, {
  name: integrationAccountName,
  location,
  sku: { name: "Basic" },
  properties: {},
});

new ApiConnection(
  stack,
  {
    name: teamsConnectionName,
    location,
    properties: {
      displayName: "teams",
      api: { id: managedApiId("teams") },
      parameterValues: {},
    },
  },
  { condition: createTeamsConnection },
);

new ApiConnection(stack, {
  name: azureBlobConnectionName,
  location,
  properties: {
    displayName: "azureblob",
    api: { id: managedApiId("azureblob") },
    parameterValueSet: { name: "managedIdentityAuth", values: {} },
  },
});

new ApiConnection(stack, {
  name: documentDbConnectionName,
  location,
  properties: {
    displayName: "documentdb",
    api: { id: managedApiId("documentdb") },
    parameterValueSet: { name: "managedIdentityAuth", values: {} },
  },
});

const workflow = new Workflow(
  stack,
  {
    name: logicAppWorkflowName,
    location,
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: fn.union(
        fn.json(fn.concat('{"', botIdentityResourceId, '":{}}')),
        fn.json(fn.concat('{"', serverIdentityResourceId, '":{}}')),
      ) as any,
    },
    properties: {
      state: "Enabled",
      integrationAccount: { id: integrationAccount.id },
      definition: createLogicAppWorkflowDefinition(functionAppResourceId),
      parameters: {
        $connections: {
          value: {
            azureblob: {
              connectionId: connectionResourceId(azureBlobConnectionName),
              connectionName: azureBlobConnectionName,
              connectionProperties: {
                authentication: {
                  identity: serverIdentityResourceId,
                  type: "ManagedServiceIdentity",
                },
              },
              id: managedApiId("azureblob"),
            },
            documentdb: {
              connectionId: connectionResourceId(documentDbConnectionName),
              connectionName: documentDbConnectionName,
              connectionProperties: {
                authentication: {
                  identity: serverIdentityResourceId,
                  type: "ManagedServiceIdentity",
                },
              },
              id: managedApiId("documentdb"),
            },
            teams: {
              connectionId: connectionResourceId(teamsConnectionName),
              connectionName: teamsConnectionName,
              connectionProperties: {},
              id: managedApiId("teams"),
            },
          },
        },
        teamsGroupId: { value: teamsGroupId },
        teamsChannelIds: { value: fn.split(teamsChannelIds, ",") },
        serverBaseUrl: { value: serverBaseUrl },
        serverAudience: { value: serverAudience },
        serverIdentityResourceId: { value: serverIdentityResourceId },
        botBaseUrl: { value: botBaseUrl },
        botAudience: { value: botAudience },
        botId: { value: botId },
        botIdentityResourceId: { value: botIdentityResourceId },
        functionAppResourceId: { value: functionAppResourceId },
        blobStorageAccountName: { value: storageAccountName },
      },
    } as any,
  },
  { condition: deployWorkflow },
);

new MetricAlert(
  stack,
  {
    name: logicAppAlertName,
    location: "global",
    properties: {
      severity: 3,
      enabled: true,
      scopes: [workflow.id],
      evaluationFrequency: "PT1M",
      autoMitigate: true,
      targetResourceType: "Microsoft.Logic/workflows",
      targetResourceRegion: location,
      actions: [
        {
          actionGroupId: fn.resourceId(
            "Microsoft.Insights/actionGroups",
            actionGroupName,
          ),
          webHookProperties: {},
        },
      ],
      windowSize: "PT5M",
      criteria: {
        allOf: [
          {
            operator: "GreaterThan",
            threshold: 0,
            name: "RunsFailed",
            metricNamespace: "Microsoft.Logic/workflows",
            metricName: "RunsFailed",
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
  },
  { condition: deployWorkflow },
);

stack.outputs.add("LOGIC_APP_WORKFLOW_NAME", "string", logicAppWorkflowName);
stack.outputs.add("TEAMS_CONNECTION_NAME", "string", teamsConnectionName);
stack.outputs.add(
  "AZURE_BLOB_CONNECTION_NAME",
  "string",
  azureBlobConnectionName,
);
stack.outputs.add(
  "DOCUMENT_DB_CONNECTION_NAME",
  "string",
  documentDbConnectionName,
);

const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION"),
    managedIdentityName: fn.readEnvironmentVariable("MANAGED_IDENTITY_NAME"),
    botIdentityName: fn.readEnvironmentVariable("BOT_IDENTITY_NAME"),
    integrationAccountName: fn.readEnvironmentVariable(
      "INTEGRATION_ACCOUNT_NAME",
      "",
    ),
    teamsConnectionName: fn.readEnvironmentVariable(
      "TEAMS_CONNECTION_NAME",
      "",
    ),
    azureBlobConnectionName: fn.readEnvironmentVariable(
      "AZURE_BLOB_CONNECTION_NAME",
      "",
    ),
    documentDbConnectionName: fn.readEnvironmentVariable(
      "DOCUMENT_DB_CONNECTION_NAME",
      "",
    ),
    logicAppWorkflowName: fn.readEnvironmentVariable(
      "LOGIC_APP_WORKFLOW_NAME",
      "",
    ),
    logicAppAlertName: fn.readEnvironmentVariable(
      "LOGIC_APP_ALERT_NAME",
      "",
    ),
    actionGroupName: fn.readEnvironmentVariable("ACTION_GROUP_NAME"),
    functionAppName: fn.readEnvironmentVariable("FUNCTION_APP_NAME"),
    teamsGroupId: fn.readEnvironmentVariable("LOGIC_APP_TEAMS_GROUP_ID"),
    teamsChannelIds: fn.readEnvironmentVariable(
      "LOGIC_APP_TEAMS_CHANNEL_IDS",
    ),
    serverBaseUrl: fn.readEnvironmentVariable("SERVER_BASE_URL"),
    serverAudience: fn.readEnvironmentVariable("SERVER_AUDIENCE"),
    botBaseUrl: fn.readEnvironmentVariable("BOT_BASE_URL"),
    botAudience: fn.readEnvironmentVariable("BOT_AUDIENCE"),
    botId: fn.readEnvironmentVariable("BOT_ID"),
    storageAccountName: fn.readEnvironmentVariable("STORAGE_ACCOUNT_NAME"),
    createTeamsConnection: fn.eq(
      fn.readEnvironmentVariable("CREATE_TEAMS_CONNECTION", "true"),
      "true",
    ),
    deployWorkflow: fn.eq(
      fn.readEnvironmentVariable("DEPLOY_LOGIC_APP_WORKFLOW", "true"),
      "true",
    ),
  },
});

export const outputJson = serialize([stack]);
const [renderedStack] = renderBicepFiles(outputJson);
if (renderedStack === undefined) {
  throw new Error("Logic App provisioning produced no Bicep entry file.");
}
export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];