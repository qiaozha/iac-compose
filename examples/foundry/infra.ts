import {
  createBicepParameterFile,
  renderBicepFiles,
  renderBicepParameterFile,
} from "@azure/provisioning-bicep";
import { RoleAssignment } from "@azure/provisioning-authorization";
import {
  Account,
  Deployment as ModelDeployment,
  Project,
} from "@azure/provisioning-cognitiveservices";
import { fn, Stack } from "@azure/provisioning-core";
import { serialize } from "@azure/provisioning-serialization";

const stack = new Stack("main", { targetScope: "resourceGroup" });
const location = stack.parameters.add("location", "string");
const deploymentPrincipalId = stack.parameters.add("deploymentPrincipalId", "string", {
  minLength: 36,
  maxLength: 36,
});
const deploymentPrincipalType = stack.parameters.add("deploymentPrincipalType", "string", {
  allowed: ["User", "ServicePrincipal"],
});
const accountName = stack.variables.add(
  "accountName",
  fn.concat("cs336-foundry-", fn.uniqueString(fn.resourceGroup().id)),
);

const account = new Account(stack, {
  name: accountName,
  location,
  kind: "AIServices",
  sku: { name: "S0" },
  identity: { type: "SystemAssigned" },
  properties: {
    customSubDomainName: accountName,
    allowProjectManagement: true,
    disableLocalAuth: true,
    publicNetworkAccess: "Enabled",
  },
});

const roleDefinitionId = stack.variables.add(
  "foundryProjectManagerRoleDefinitionId",
  fn.subscriptionResourceId(
    "Microsoft.Authorization/roleDefinitions",
    "eadc314b-1a2d-4efa-be10-5d325db5065e",
  ),
);
const deployerRoleAssignment = new RoleAssignment(account, {
  name: fn.guid(account.id, deploymentPrincipalId, roleDefinitionId),
  properties: {
    roleDefinitionId,
    principalId: deploymentPrincipalId,
    principalType: deploymentPrincipalType,
  },
});

const project = new Project(account, {
  name: "cs336-project",
  location,
  identity: { type: "SystemAssigned" },
  properties: {
    displayName: "cs336",
    description: "Foundry project for cs336.",
  },
});

const modelDeployment = new ModelDeployment(account, {
  name: "deepseek-v4-1-flash",
  sku: { name: "GlobalStandard", capacity: 50 },
  properties: {
    model: {
      format: "DeepSeek",
      name: "DeepSeek-V4.1-Flash",
      version: "2026-09-10",
    },
    versionUpgradeOption: "NoAutoUpgrade",
  },
}, {
  // Cognitive Services rejects concurrent child updates on the same account.
  dependsOn: [project],
});

const endpoints = project.properties.endpoints;
if (endpoints === undefined) {
  throw new Error("The Foundry provisioning library did not expose project endpoints.");
}

stack.outputs.add("AZURE_SUBSCRIPTION_ID", "string", fn.subscription().subscriptionId);
stack.outputs.add("AZURE_RESOURCE_GROUP", "string", fn.resourceGroup().name);
stack.outputs.add("AZURE_AI_LOCATION", "string", location);
stack.outputs.add("AZURE_AI_ACCOUNT_ID", "string", account.id);
stack.outputs.add("AZURE_AI_ACCOUNT_NAME", "string", account.name);
stack.outputs.add("AZURE_AI_PROJECT_ID", "string", project.id);
stack.outputs.add("AZURE_AI_PROJECT_NAME", "string", project.name);
stack.outputs.add("AZURE_AI_PROJECT_ENDPOINT", "string", endpoints["AI Foundry API"]);
stack.outputs.add("AZURE_AI_MODEL_DEPLOYMENT_ID", "string", modelDeployment.id);
stack.outputs.add("AZURE_AI_MODEL_DEPLOYMENT_NAME", "string", modelDeployment.name);
stack.outputs.add("AZURE_FOUNDRY_ROLE_ASSIGNMENT_ID", "string", deployerRoleAssignment.id);
stack.outputs.add("AZURE_FOUNDRY_PRINCIPAL_ID", "string", deploymentPrincipalId);

export const outputJson = serialize([stack]);
const [renderedStack] = renderBicepFiles(outputJson);
if (renderedStack === undefined) {
  throw new Error("Foundry provisioning produced no Bicep entry file.");
}

const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_AI_LOCATION"),
    deploymentPrincipalId: fn.readEnvironmentVariable("AZURE_PRINCIPAL_ID"),
    deploymentPrincipalType: fn.readEnvironmentVariable("AZURE_PRINCIPAL_TYPE"),
  },
});

export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];
