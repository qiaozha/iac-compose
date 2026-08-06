import {
  bicepRef,
  createBicepParameterFile,
  renderBicepFile,
} from "@azure/provisioning-bicep";
import {
  fn,
  Stack,
  type ExpressionOrValue,
} from "@azure/provisioning-core";

import { renderGraphStack } from "./graph-provisioning.js";

const azureCliApplicationId = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

const stack = new Stack("main", { targetScope: "subscription" });
const environmentName = stack.parameters.add("environmentName", "string");
const applicationUniqueName = stack.parameters.add(
  "applicationUniqueName",
  "string",
  { defaultValue: "" },
);
const serviceManagementReference = stack.parameters.add(
  "serviceManagementReference",
  "string",
  { defaultValue: "" },
);
const serverAudience = stack.parameters.add("serverAudience", "string");
const preAuthorizeClients = stack.parameters.add("preAuthorizeClients", "string", {
  defaultValue: "",
});
const managedIdentityPrincipalId = stack.parameters.add(
  "managedIdentityPrincipalId",
  "string",
  { defaultValue: "" },
);
const botIdentityPrincipalId = stack.parameters.add(
  "botIdentityPrincipalId",
  "string",
  { defaultValue: "" },
);
const delegatedScopeId = stack.parameters.add("delegatedScopeId", "string", {
  defaultValue: "",
});
const applicationRoleId = stack.parameters.add("applicationRoleId", "string", {
  defaultValue: "",
});
const existingPermissionScopes = stack.parameters.add(
  "existingPermissionScopes",
  "array",
  { defaultValue: [] },
);
const existingApplicationRoles = stack.parameters.add(
  "existingApplicationRoles",
  "array",
  { defaultValue: [] },
);

const applicationName = stack.variables.add(
  "applicationName",
  fn.concat("azuresdkqabot-server-", environmentName),
);
const effectiveApplicationUniqueName = stack.variables.add(
  "effectiveApplicationUniqueName",
  fn.cond(
    fn.not(fn.empty(applicationUniqueName)),
    applicationUniqueName,
    applicationName,
  ),
);
const effectiveDelegatedScopeId = stack.variables.add(
  "effectiveDelegatedScopeId",
  fn.cond(
    fn.not(fn.empty(delegatedScopeId)),
    delegatedScopeId,
    fn.guid(serverAudience, "access_as_user"),
  ),
);
const effectiveApplicationRoleId = stack.variables.add(
  "effectiveApplicationRoleId",
  fn.cond(
    fn.not(fn.empty(applicationRoleId)),
    applicationRoleId,
    fn.guid(serverAudience, "access_as_application"),
  ),
);

const permissionScope = {
  id: effectiveDelegatedScopeId,
  value: "access_as_user",
  type: "User",
  isEnabled: true,
  adminConsentDisplayName: "Access the chatbot server",
  adminConsentDescription: "Allow the application to access the chatbot server.",
  userConsentDisplayName: "Access the chatbot server",
  userConsentDescription: "Allow this application to access the chatbot server.",
};
const applicationRole = {
  id: effectiveApplicationRoleId,
  value: "access_as_application",
  displayName: "Access chatbot server as application",
  description: "Allow an application identity to access the chatbot server.",
  isEnabled: true,
  allowedMemberTypes: ["Application"],
};
type PreAuthorizedApplication = {
  appId: ExpressionOrValue<string>;
  delegatedPermissionIds: ExpressionOrValue<string>[];
};
const preAuthorizedApplications = fn.cond<PreAuthorizedApplication[]>(
  fn.eq(preAuthorizeClients, "true"),
  [
    {
      appId: azureCliApplicationId,
      delegatedPermissionIds: [effectiveDelegatedScopeId],
    },
  ],
  [],
);
const serverApplicationId = bicepRef<string>("serverApplication.id");
const serverApplicationAppId = bicepRef<string>("serverApplication.appId");
const serverServicePrincipalId = bicepRef<string>("serverServicePrincipal.id");

stack.outputs.add("SERVER_AUDIENCE", "string", serverApplicationAppId);
stack.outputs.add(
  "SERVER_APPLICATION_UNIQUE_NAME",
  "string",
  effectiveApplicationUniqueName,
);
stack.outputs.add(
  "SERVER_APPLICATION_OBJECT_ID",
  "string",
  serverApplicationId,
);
stack.outputs.add(
  "SERVER_SERVICE_PRINCIPAL_ID",
  "string",
  serverServicePrincipalId,
);
stack.outputs.add(
  "SERVER_APPLICATION_ROLE_ID",
  "string",
  effectiveApplicationRoleId,
);
stack.outputs.add(
  "SERVER_DELEGATED_SCOPE_ID",
  "string",
  effectiveDelegatedScopeId,
);
stack.outputs.add(
  "RAG_SERVICE_SCOPE",
  "string",
  fn.concat("api://", serverAudience, "/.default"),
);

const rendered = renderGraphStack(stack, [
  {
    identifier: "serverApplication",
    type: "Microsoft.Graph/applications",
    body: {
      uniqueName: effectiveApplicationUniqueName,
      displayName: applicationName,
      signInAudience: "AzureADMyOrg",
      serviceManagementReference: fn.cond<string | null>(
        fn.not(fn.empty(serviceManagementReference)),
        serviceManagementReference,
        null,
      ),
      identifierUris: [fn.concat("api://", serverAudience)],
      api: {
        requestedAccessTokenVersion: 2,
        oauth2PermissionScopes: fn.union(existingPermissionScopes, [
          permissionScope,
        ]),
        preAuthorizedApplications,
      },
      appRoles: fn.union(existingApplicationRoles, [applicationRole]),
    },
  },
  {
    identifier: "serverServicePrincipal",
    type: "Microsoft.Graph/servicePrincipals",
    body: {
      appId: serverAudience,
      dependsOn: [bicepRef("serverApplication")],
    },
  },
  {
    identifier: "managedIdentityRoleAssignment",
    type: "Microsoft.Graph/appRoleAssignedTo",
    condition: fn.not(fn.empty(managedIdentityPrincipalId)),
    body: {
      appRoleId: effectiveApplicationRoleId,
      principalId: managedIdentityPrincipalId,
      resourceId: serverServicePrincipalId,
      resourceDisplayName: applicationName,
    },
  },
  {
    identifier: "botIdentityRoleAssignment",
    type: "Microsoft.Graph/appRoleAssignedTo",
    condition: fn.not(fn.empty(botIdentityPrincipalId)),
    body: {
      appRoleId: effectiveApplicationRoleId,
      principalId: botIdentityPrincipalId,
      resourceId: serverServicePrincipalId,
      resourceDisplayName: applicationName,
    },
  },
]);

const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    environmentName: fn.readEnvironmentVariable("AZURE_ENV_NAME"),
    applicationUniqueName: fn.readEnvironmentVariable(
      "SERVER_APPLICATION_UNIQUE_NAME",
      "",
    ),
    serviceManagementReference: fn.readEnvironmentVariable(
      "SERVICE_MANAGEMENT_REFERENCE",
      "",
    ),
    serverAudience: fn.readEnvironmentVariable("SERVER_AUDIENCE"),
    preAuthorizeClients: fn.readEnvironmentVariable(
      "SERVER_PREAUTHORIZE_CLIENTS",
      "false",
    ),
    managedIdentityPrincipalId: fn.readEnvironmentVariable(
      "MANAGED_IDENTITY_PRINCIPAL_ID",
      "",
    ),
    botIdentityPrincipalId: fn.readEnvironmentVariable(
      "BOT_IDENTITY_PRINCIPAL_ID",
      "",
    ),
    delegatedScopeId: fn.readEnvironmentVariable(
      "SERVER_DELEGATED_SCOPE_ID",
      "",
    ),
    applicationRoleId: fn.readEnvironmentVariable(
      "SERVER_APPLICATION_ROLE_ID",
      "",
    ),
    existingPermissionScopes: fn.json(
      fn.readEnvironmentVariable("SERVER_EXISTING_PERMISSION_SCOPES", "[]"),
    ),
    existingApplicationRoles: fn.json(
      fn.readEnvironmentVariable("SERVER_EXISTING_APPLICATION_ROLES", "[]"),
    ),
  },
});

export const outputJson = rendered.outputJson;
export const outputBicep = [
  { ...rendered.main, path: "main.bicep" },
  renderBicepFile(parameterFile),
];