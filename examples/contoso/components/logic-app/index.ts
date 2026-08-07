import {
  enableWorkflowDeployment,
  prepareAuthorizedConnection,
  type Deployment,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  generatedLogicAppProject,
  logicAppProvisioningEntrypoint,
} from "../../runtime/paths.js";

export async function logicApp(deployment: Deployment): Promise<void> {
  const connectionName =
    process.env["DEPLOY_RESOURCE_TEAMSCONNECTION_NAME"]?.trim() || "teams";
  const connectionStatus = await prepareAuthorizedConnection(deployment, {
    resourceId: "teamsConnection",
    name: connectionName,
  });
  process.env["DEPLOY_WORKFLOW_AUTOREPLYWORKFLOW"] =
    deployment.dryRun || connectionStatus === "Connected" ? "true" : "false";
  const infrastructureOutputs = await deployment.provision(
    "logic-app infrastructure",
    {
      entrypoint: logicAppProvisioningEntrypoint,
      outputDirectory: generatedLogicAppProject,
      deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-logic-app`,
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: requiredEnv("AZURE_LOCATION"),
    },
  );
  await deployment.deploy("persist logic-app infrastructure", async () => {
    await persistEnvironment(
      requiredEnv("AZURE_ENV_NAME"),
      infrastructureOutputs,
    );
  });

  const validationValues = {
    "teamsGroupId":
      process.env["DEPLOY_WORKFLOW_AUTOREPLYWORKFLOW_TEAMSGROUPID"] ?? "e33c7fe9-84fa-47c8-a288-1a23b7b92ea5",
    "teamsChannelIds": (
      process.env["DEPLOY_WORKFLOW_AUTOREPLYWORKFLOW_TEAMSCHANNELIDS"] ?? "19:ZK2wSwDjcdWUr_0jR1njUWFbnTCzKJ8QnyyDkNURqUE1@thread.tacv2"
    ).split(","),
    "frontendAudience":
      process.env["DEPLOY_WORKFLOW_AUTOREPLYWORKFLOW_FRONTENDAUDIENCE"] ?? "https://api.botframework.com",
  };
  await enableWorkflowDeployment(deployment, {
    component: "logic-app",
    workflowId: "autoReplyWorkflow",
    workflowName: deploymentValue(
      deployment,
      "DEPLOY_RESOURCE_AUTOREPLYWORKFLOW_NAME",
    ),
    validationValues,
    connectionName: deploymentValue(
      deployment,
      "DEPLOY_RESOURCE_TEAMSCONNECTION_NAME",
    ),
    authorizationTenantId: "70a036f6-8e4d-4615-bad6-149c02e7720d",

  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "${" + name + "}" : requiredEnv(name);
}
