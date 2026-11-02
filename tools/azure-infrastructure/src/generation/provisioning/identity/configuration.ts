import { pascalCase } from "../names.js";
import type { ProvisioningSourceOptions } from "../types.js";
import { entraApplicationPlans, entraOutput } from "./planning.js";

export function renderEntraIdentityConfigurationSource(
  options: ProvisioningSourceOptions,
): string {
  const plans = entraApplicationPlans(options);
  if (plans.length === 0) return "";
  const declarations = plans.map((plan) => {
    const principalDeclarations = plan.callerPrincipalOutputs.map((output) => {
      const variable = `${plan.base}${pascalCase(output)}`;
      return `const ${variable} = stack.parameters.add(${JSON.stringify(variable)}, "string", {
  defaultValue: "",
});`;
    }).join("\n");
    const clients = plan.authorizedClientApplicationIds.map((appId) => `    {
      appId: ${JSON.stringify(appId)},
      delegatedPermissionIds: [${plan.base}EffectiveDelegatedScopeId],
    },`).join("\n");
    return `const ${plan.base}ApplicationAppId = stack.parameters.add(${JSON.stringify(`${plan.base}ApplicationAppId`)}, "string");
const ${plan.base}ApplicationUniqueName = stack.parameters.add(${JSON.stringify(`${plan.base}ApplicationUniqueName`)}, "string");
const ${plan.base}PreAuthorizeClients = stack.parameters.add(${JSON.stringify(`${plan.base}PreAuthorizeClients`)}, "string", {
  defaultValue: "false",
});
const ${plan.base}DelegatedScopeId = stack.parameters.add(${JSON.stringify(`${plan.base}DelegatedScopeId`)}, "string", {
  defaultValue: "",
});
const ${plan.base}ApplicationRoleId = stack.parameters.add(${JSON.stringify(`${plan.base}ApplicationRoleId`)}, "string", {
  defaultValue: "",
});
const ${plan.base}ExistingPermissionScopes = stack.parameters.add(${JSON.stringify(`${plan.base}ExistingPermissionScopes`)}, "array", {
  defaultValue: [],
});
const ${plan.base}ExistingApplicationRoles = stack.parameters.add(${JSON.stringify(`${plan.base}ExistingApplicationRoles`)}, "array", {
  defaultValue: [],
});
${principalDeclarations}
const ${plan.base}Audience = fn.concat("api://", ${plan.base}ApplicationAppId);
const ${plan.base}EffectiveDelegatedScopeId = fn.cond(
  fn.not(fn.empty(${plan.base}DelegatedScopeId)),
  ${plan.base}DelegatedScopeId,
  fn.guid(${plan.base}ApplicationAppId, ${JSON.stringify(plan.delegatedPermissionScope)}),
);
const ${plan.base}EffectiveApplicationRoleId = fn.cond(
  fn.not(fn.empty(${plan.base}ApplicationRoleId)),
  ${plan.base}ApplicationRoleId,
  fn.guid(${plan.base}ApplicationAppId, "access_as_application"),
);
const ${plan.base}PermissionScope = {
  id: ${plan.base}EffectiveDelegatedScopeId,
  value: ${JSON.stringify(plan.delegatedPermissionScope)},
  type: "User",
  isEnabled: true,
  adminConsentDisplayName: ${JSON.stringify(`Access ${plan.displayName}`)},
  adminConsentDescription: ${JSON.stringify(`Allow the application to access ${plan.displayName}.`)},
  userConsentDisplayName: ${JSON.stringify(`Access ${plan.displayName}`)},
  userConsentDescription: ${JSON.stringify(`Allow this application to access ${plan.displayName}.`)},
};
const ${plan.base}ApplicationRole = {
  id: ${plan.base}EffectiveApplicationRoleId,
  value: "access_as_application",
  displayName: ${JSON.stringify(`Access ${plan.displayName} as an application`)},
  description: ${JSON.stringify(`Allow a managed identity to access ${plan.displayName}.`)},
  isEnabled: true,
  allowedMemberTypes: ["Application"],
};
const ${plan.base}PreAuthorizedApplications = fn.cond<PreAuthorizedApplication[]>(
  fn.eq(${plan.base}PreAuthorizeClients, "true"),
  [
${clients}
  ],
  [],
);
const ${plan.base}ApplicationObjectId = bicepRef<string>(${JSON.stringify(`${plan.base}Application.id`)});
const ${plan.base}ServicePrincipalId = bicepRef<string>(${JSON.stringify(`${plan.base}ServicePrincipal.id`)});

stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_APP_ID"))}, "string", ${plan.base}ApplicationAppId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_OBJECT_ID"))}, "string", ${plan.base}ApplicationObjectId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "SERVICE_PRINCIPAL_ID"))}, "string", ${plan.base}ServicePrincipalId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_UNIQUE_NAME"))}, "string", ${plan.base}ApplicationUniqueName);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "DELEGATED_SCOPE_ID"))}, "string", ${plan.base}EffectiveDelegatedScopeId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_ROLE_ID"))}, "string", ${plan.base}EffectiveApplicationRoleId);`;
  }).join("\n\n");
  const resources = plans.map((plan) => {
    const assignments = plan.callerPrincipalOutputs.map((output) => {
      const variable = `${plan.base}${pascalCase(output)}`;
      return `  {
    identifier: ${JSON.stringify(`${plan.base}${pascalCase(output)}RoleAssignment`)},
    type: "Microsoft.Graph/appRoleAssignedTo",
    condition: fn.not(fn.empty(${variable})),
    body: {
      appRoleId: ${plan.base}EffectiveApplicationRoleId,
      principalId: ${variable},
      resourceId: ${plan.base}ServicePrincipalId,
      resourceDisplayName: ${JSON.stringify(plan.displayName)},
    },
  },`;
    }).join("\n");
    return `  {
    identifier: ${JSON.stringify(`${plan.base}Application`)},
    type: "Microsoft.Graph/applications",
    body: {
      uniqueName: ${plan.base}ApplicationUniqueName,
      displayName: ${JSON.stringify(plan.displayName)},
      signInAudience: "AzureADMyOrg",
      serviceManagementReference: ${JSON.stringify(options.serviceManagementReference)},
      identifierUris: [${plan.base}Audience],
      api: {
        requestedAccessTokenVersion: 2,
        oauth2PermissionScopes: fn.union(${plan.base}ExistingPermissionScopes, [
          ${plan.base}PermissionScope,
        ]),
        preAuthorizedApplications: ${plan.base}PreAuthorizedApplications,
      },
      appRoles: fn.union(${plan.base}ExistingApplicationRoles, [
        ${plan.base}ApplicationRole,
      ]),
    },
  },
  {
    identifier: ${JSON.stringify(`${plan.base}ServicePrincipal`)},
    type: "Microsoft.Graph/servicePrincipals",
    body: {
      appId: ${plan.base}ApplicationAppId,
      dependsOn: [bicepRef(${JSON.stringify(`${plan.base}Application`)})],
    },
  },
${assignments}`;
  }).join("\n");
  const bindings = plans.flatMap((plan) => [
    `    ${plan.base}ApplicationAppId: fn.readEnvironmentVariable(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_APP_ID"))}),`,
    `    ${plan.base}ApplicationUniqueName: fn.readEnvironmentVariable(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_UNIQUE_NAME"))}),`,
    `    ${plan.base}PreAuthorizeClients: fn.readEnvironmentVariable(${JSON.stringify(entraOutput(plan.resource.id, "PREAUTHORIZE_CLIENTS"))}, "false"),`,
    `    ${plan.base}DelegatedScopeId: fn.readEnvironmentVariable(${JSON.stringify(entraOutput(plan.resource.id, "DELEGATED_SCOPE_ID"))}, ""),`,
    `    ${plan.base}ApplicationRoleId: fn.readEnvironmentVariable(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_ROLE_ID"))}, ""),`,
    `    ${plan.base}ExistingPermissionScopes: fn.json(fn.readEnvironmentVariable(${JSON.stringify(entraOutput(plan.resource.id, "EXISTING_PERMISSION_SCOPES"))}, "[]")),`,
    `    ${plan.base}ExistingApplicationRoles: fn.json(fn.readEnvironmentVariable(${JSON.stringify(entraOutput(plan.resource.id, "EXISTING_APPLICATION_ROLES"))}, "[]")),`,
    ...plan.callerPrincipalOutputs.map((output) =>
      `    ${plan.base}${pascalCase(output)}: fn.readEnvironmentVariable(${JSON.stringify(output)}, ""),`
    ),
  ]).join("\n");
  return `import {
  bicepRef,
  createBicepParameterFile,
  renderBicepParameterFile,
} from "@azure/provisioning-bicep";
import { fn, Stack, type ExpressionOrValue } from "@azure/provisioning-core";

import { renderGraphStack } from "./graph-provisioning.js";

interface PreAuthorizedApplication {
  appId: ExpressionOrValue<string>;
  delegatedPermissionIds: ExpressionOrValue<string>[];
}

const stack = new Stack("main", { targetScope: "subscription" });
${declarations}

const rendered = renderGraphStack(stack, [
${resources}
]);
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
${bindings}
  },
});

export const outputJson = rendered.outputJson;
export const outputBicep = [
  { ...rendered.main, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];
`;
}