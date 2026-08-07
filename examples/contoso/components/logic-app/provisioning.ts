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
import { createAutoReplyWorkflowDefinition } from "./workflow.js";

export const solutionName = "contoso-support";

const stack = new Stack("main", { targetScope: "resourceGroup" });
const location = stack.parameters.add("location", "string");
const createTeamsConnection = stack.parameters.add("createTeamsConnection", "bool");
const deployAutoReplyWorkflow = stack.parameters.add("deployAutoReplyWorkflow", "bool");
const inputBackendAudience = stack.parameters.add("inputBackendAudience", "string");
const inputBackendIdentityResourceId = stack.parameters.add("inputBackendIdentityResourceId", "string");
const inputBackendBaseUrl = stack.parameters.add("inputBackendBaseUrl", "string");
const inputBotIdentityResourceId = stack.parameters.add("inputBotIdentityResourceId", "string");
const inputFrontendBaseUrl = stack.parameters.add("inputFrontendBaseUrl", "string");
const autoReplyWorkflowTeamsChannelIds = stack.parameters.add("autoReplyWorkflowTeamsChannelIds", "string");
const autoReplyWorkflowTeamsGroupId = stack.parameters.add("autoReplyWorkflowTeamsGroupId", "string");
const autoReplyWorkflowFrontendAudience = stack.parameters.add("autoReplyWorkflowFrontendAudience", "string");
const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);

const teamsConnectionManagedApiId = fn.concat(
  "/subscriptions/",
  fn.subscription().subscriptionId,
  "/providers/Microsoft.Web/locations/",
  location,
  "/managedApis/teams",
);

new ApiConnection(
  stack,
  {
    name: "teams",
    location,
    properties: {
      displayName: "teams",
      api: { id: teamsConnectionManagedApiId },
      parameterValues: {},
    },
  },
  { condition: createTeamsConnection },
);

const autoReplyWorkflowName = fn.concat(
  "contoso-support-autoreplyworkflow-",
  suffix,
);

const autoReplyWorkflow = new Workflow(stack, {
  name: autoReplyWorkflowName,
  location,
  identity: {
    type: "UserAssigned",
    userAssignedIdentities: fn.union(fn.json(fn.concat('{"', inputBackendIdentityResourceId, '":{}}')), fn.json(fn.concat('{"', inputBotIdentityResourceId, '":{}}'))) as any,
  },
  properties: {
    state: "Disabled",
    definition: createAutoReplyWorkflowDefinition({
    teamsChannelIds: fn.split(autoReplyWorkflowTeamsChannelIds, ","),
    teamsGroupId: autoReplyWorkflowTeamsGroupId,
    backendAudience: inputBackendAudience,
    backendIdentityResourceId: inputBackendIdentityResourceId,
    backendBaseUrl: inputBackendBaseUrl,
    frontendAudience: autoReplyWorkflowFrontendAudience,
    botIdentityResourceId: inputBotIdentityResourceId,
    frontendBaseUrl: inputFrontendBaseUrl,
    }) as any,
    parameters: {
      $connections: {
        value: {
          teams: {
            connectionId: fn.resourceId("Microsoft.Web/connections", "teams"),
            connectionName: "teams",
            connectionProperties: {},
            id: teamsConnectionManagedApiId,
          },
        },
      },
    },
  } as any,
},
  { condition: deployAutoReplyWorkflow },
);

stack.outputs.add("teamsConnectionResourceId", "string", fn.resourceId("Microsoft.Web/connections", "teams"));
stack.outputs.add("DEPLOY_RESOURCE_TEAMSCONNECTION_NAME", "string", "teams");
stack.outputs.add("DEPLOY_RESOURCE_AUTOREPLYWORKFLOW_NAME", "string", autoReplyWorkflowName);
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
    createTeamsConnection: fn.eq(
      fn.readEnvironmentVariable("DEPLOY_CREATE_RESOURCE_TEAMSCONNECTION", "true"),
      "true",
    ),
    deployAutoReplyWorkflow: fn.eq(
      fn.readEnvironmentVariable("DEPLOY_WORKFLOW_AUTOREPLYWORKFLOW", "false"),
      "true",
    ),
    inputBackendAudience: fn.readEnvironmentVariable("backendAudience"),
    inputBackendIdentityResourceId: fn.readEnvironmentVariable("backendIdentityResourceId"),
    inputBackendBaseUrl: fn.readEnvironmentVariable("backendBaseUrl"),
    inputBotIdentityResourceId: fn.readEnvironmentVariable("botIdentityResourceId"),
    inputFrontendBaseUrl: fn.readEnvironmentVariable("frontendBaseUrl"),
    autoReplyWorkflowTeamsChannelIds: fn.readEnvironmentVariable("DEPLOY_WORKFLOW_AUTOREPLYWORKFLOW_TEAMSCHANNELIDS", "19:ZK2wSwDjcdWUr_0jR1njUWFbnTCzKJ8QnyyDkNURqUE1@thread.tacv2"),
    autoReplyWorkflowTeamsGroupId: fn.readEnvironmentVariable("DEPLOY_WORKFLOW_AUTOREPLYWORKFLOW_TEAMSGROUPID", "e33c7fe9-84fa-47c8-a288-1a23b7b92ea5"),
    autoReplyWorkflowFrontendAudience: fn.readEnvironmentVariable("DEPLOY_WORKFLOW_AUTOREPLYWORKFLOW_FRONTENDAUDIENCE", "https://api.botframework.com"),
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
