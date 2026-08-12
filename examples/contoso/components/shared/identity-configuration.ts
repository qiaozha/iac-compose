import {
  bicepRef,
  createBicepParameterFile,
  renderBicepFile,
} from "@azure/provisioning-bicep";
import { fn, Stack, type ExpressionOrValue } from "@azure/provisioning-core";

import { renderGraphStack } from "./graph-provisioning.js";

interface PreAuthorizedApplication {
  appId: ExpressionOrValue<string>;
  delegatedPermissionIds: ExpressionOrValue<string>[];
}

const stack = new Stack("main", { targetScope: "subscription" });
const backendComputeApplicationAppId = stack.parameters.add("backendComputeApplicationAppId", "string");
const backendComputeApplicationUniqueName = stack.parameters.add("backendComputeApplicationUniqueName", "string");
const backendComputePreAuthorizeClients = stack.parameters.add("backendComputePreAuthorizeClients", "string", {
  defaultValue: "false",
});
const backendComputeDelegatedScopeId = stack.parameters.add("backendComputeDelegatedScopeId", "string", {
  defaultValue: "",
});
const backendComputeApplicationRoleId = stack.parameters.add("backendComputeApplicationRoleId", "string", {
  defaultValue: "",
});
const backendComputeExistingPermissionScopes = stack.parameters.add("backendComputeExistingPermissionScopes", "array", {
  defaultValue: [],
});
const backendComputeExistingApplicationRoles = stack.parameters.add("backendComputeExistingApplicationRoles", "array", {
  defaultValue: [],
});
const backendComputeBotIdentityPrincipalId = stack.parameters.add("backendComputeBotIdentityPrincipalId", "string", {
  defaultValue: "",
});
const backendComputeBackendIdentityPrincipalId = stack.parameters.add("backendComputeBackendIdentityPrincipalId", "string", {
  defaultValue: "",
});
const backendComputeAudience = fn.concat("api://", backendComputeApplicationAppId);
const backendComputeEffectiveDelegatedScopeId = fn.cond(
  fn.not(fn.empty(backendComputeDelegatedScopeId)),
  backendComputeDelegatedScopeId,
  fn.guid(backendComputeApplicationAppId, "token"),
);
const backendComputeEffectiveApplicationRoleId = fn.cond(
  fn.not(fn.empty(backendComputeApplicationRoleId)),
  backendComputeApplicationRoleId,
  fn.guid(backendComputeApplicationAppId, "access_as_application"),
);
const backendComputePermissionScope = {
  id: backendComputeEffectiveDelegatedScopeId,
  value: "token",
  type: "User",
  isEnabled: true,
  adminConsentDisplayName: "Access contoso-support backendCompute API",
  adminConsentDescription: "Allow the application to access contoso-support backendCompute API.",
  userConsentDisplayName: "Access contoso-support backendCompute API",
  userConsentDescription: "Allow this application to access contoso-support backendCompute API.",
};
const backendComputeApplicationRole = {
  id: backendComputeEffectiveApplicationRoleId,
  value: "access_as_application",
  displayName: "Access contoso-support backendCompute API as an application",
  description: "Allow a managed identity to access contoso-support backendCompute API.",
  isEnabled: true,
  allowedMemberTypes: ["Application"],
};
const backendComputePreAuthorizedApplications = fn.cond<PreAuthorizedApplication[]>(
  fn.eq(backendComputePreAuthorizeClients, "true"),
  [
    {
      appId: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
      delegatedPermissionIds: [backendComputeEffectiveDelegatedScopeId],
    },
  ],
  [],
);
const backendComputeApplicationObjectId = bicepRef<string>("backendComputeApplication.id");
const backendComputeServicePrincipalId = bicepRef<string>("backendComputeServicePrincipal.id");

stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_APP_ID", "string", backendComputeApplicationAppId);
stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_OBJECT_ID", "string", backendComputeApplicationObjectId);
stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_SERVICE_PRINCIPAL_ID", "string", backendComputeServicePrincipalId);
stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_UNIQUE_NAME", "string", backendComputeApplicationUniqueName);
stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_DELEGATED_SCOPE_ID", "string", backendComputeEffectiveDelegatedScopeId);
stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_ROLE_ID", "string", backendComputeEffectiveApplicationRoleId);

const rendered = renderGraphStack(stack, [
  {
    identifier: "backendComputeApplication",
    type: "Microsoft.Graph/applications",
    body: {
      uniqueName: backendComputeApplicationUniqueName,
      displayName: "contoso-support backendCompute API",
      signInAudience: "AzureADMyOrg",
      serviceManagementReference: "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4",
      identifierUris: [backendComputeAudience],
      api: {
        requestedAccessTokenVersion: 2,
        oauth2PermissionScopes: fn.union(backendComputeExistingPermissionScopes, [
          backendComputePermissionScope,
        ]),
        preAuthorizedApplications: backendComputePreAuthorizedApplications,
      },
      appRoles: fn.union(backendComputeExistingApplicationRoles, [
        backendComputeApplicationRole,
      ]),
    },
  },
  {
    identifier: "backendComputeServicePrincipal",
    type: "Microsoft.Graph/servicePrincipals",
    body: {
      appId: backendComputeApplicationAppId,
      dependsOn: [bicepRef("backendComputeApplication")],
    },
  },
  {
    identifier: "backendComputeBotIdentityPrincipalIdRoleAssignment",
    type: "Microsoft.Graph/appRoleAssignedTo",
    condition: fn.not(fn.empty(backendComputeBotIdentityPrincipalId)),
    body: {
      appRoleId: backendComputeEffectiveApplicationRoleId,
      principalId: backendComputeBotIdentityPrincipalId,
      resourceId: backendComputeServicePrincipalId,
      resourceDisplayName: "contoso-support backendCompute API",
    },
  },
  {
    identifier: "backendComputeBackendIdentityPrincipalIdRoleAssignment",
    type: "Microsoft.Graph/appRoleAssignedTo",
    condition: fn.not(fn.empty(backendComputeBackendIdentityPrincipalId)),
    body: {
      appRoleId: backendComputeEffectiveApplicationRoleId,
      principalId: backendComputeBackendIdentityPrincipalId,
      resourceId: backendComputeServicePrincipalId,
      resourceDisplayName: "contoso-support backendCompute API",
    },
  },
]);
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    backendComputeApplicationAppId: fn.readEnvironmentVariable("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_APP_ID"),
    backendComputeApplicationUniqueName: fn.readEnvironmentVariable("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_UNIQUE_NAME"),
    backendComputePreAuthorizeClients: fn.readEnvironmentVariable("DEPLOY_ENTRA_BACKENDCOMPUTE_PREAUTHORIZE_CLIENTS", "false"),
    backendComputeDelegatedScopeId: fn.readEnvironmentVariable("DEPLOY_ENTRA_BACKENDCOMPUTE_DELEGATED_SCOPE_ID", ""),
    backendComputeApplicationRoleId: fn.readEnvironmentVariable("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_ROLE_ID", ""),
    backendComputeExistingPermissionScopes: fn.json(fn.readEnvironmentVariable("DEPLOY_ENTRA_BACKENDCOMPUTE_EXISTING_PERMISSION_SCOPES", "[]")),
    backendComputeExistingApplicationRoles: fn.json(fn.readEnvironmentVariable("DEPLOY_ENTRA_BACKENDCOMPUTE_EXISTING_APPLICATION_ROLES", "[]")),
    backendComputeBotIdentityPrincipalId: fn.readEnvironmentVariable("botIdentityPrincipalId", ""),
    backendComputeBackendIdentityPrincipalId: fn.readEnvironmentVariable("backendIdentityPrincipalId", ""),
  },
});

export const outputJson = rendered.outputJson;
export const outputBicep = [
  { ...rendered.main, path: "main.bicep" },
  renderBicepFile(parameterFile),
];
