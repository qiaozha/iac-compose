import { relative as pathRelative } from "node:path";

import type {
  DeploymentSolution,
  ResourceRequirement,
  ResourceRequirements,
} from "./generator.js";

export interface ProvisioningSourceOptions {
  requirements: ResourceRequirements;
  solution: DeploymentSolution;
  orderedComponents: readonly string[];
  templates: Readonly<Record<string, unknown>>;
  serviceManagementReference: string;
}

interface WorkflowPlan {
  resource: ResourceRequirement;
  definition: Readonly<Record<string, unknown>>;
  templateParameters: Readonly<Record<string, unknown>>;
  functionName: string;
  importPath: string;
  deploymentCondition?: string;
  parameterExpressions: ReadonlyMap<string, string>;
  parameterDeclarations: readonly string[];
  parameterBindings: readonly string[];
}

const roleIds: Readonly<Record<string, string>> = {
  AcrPull: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  "App Configuration Data Reader": "516239f1-63e1-4d78-a4de-a74fb236a071",
  "Azure AI User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Foundry User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Storage Blob Data Contributor": "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
};

export function renderProvisioningSource(
  options: ProvisioningSourceOptions,
): string {
  if (options.requirements.resources.length === 0) {
    return `export const solutionName = ${JSON.stringify(options.requirements.solution.name)};

export const outputBicep = [
  { path: "main.bicep", contents: "targetScope = 'resourceGroup'\\n" },
  { path: "main.bicepparam", contents: "using './main.bicep'\\n" },
];
`;
  }
  return new ProvisioningSourceRenderer(options).render();
}

export function renderProvisioningSources(
  options: ProvisioningSourceOptions,
): ReadonlyMap<string, string> {
  if (options.requirements.resources.length === 0) {
    return new Map([["shared", renderProvisioningSource(options)]]);
  }
  const sources = new Map<string, string>();
  for (const owner of ["shared", ...options.orderedComponents]) {
    if (!ownerNeedsProvisioning(options, owner)) continue;
    sources.set(owner, new ProvisioningSourceRenderer(options, owner).render());
  }
  return sources;
}

export function renderWorkflowDefinitionSources(
  options: ProvisioningSourceOptions,
): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const resource of options.requirements.resources) {
    if (resource.kind !== "workflow-host") continue;
    const template = requiredObject(
      options.templates[resource.id],
      `Workflow template '${resource.id}'`,
    );
    const templateResource = requiredArray(
      template.resources,
      `Workflow template '${resource.id}'.resources`,
    )[0];
    const definition = requiredObject(
      requiredObject(
        requiredObject(templateResource, `${resource.id}.resources[0]`).properties,
        `${resource.id}.resources[0].properties`,
      ).definition,
      `${resource.id}.definition`,
    );
    const functionName = `create${pascalCase(resource.id)}Definition`;
    const inputNames = collectWorkflowInputs(definition);
    const templateParameters = asObject(template.parameters);
    const interfaceName = `${pascalCase(resource.id)}Inputs`;
    const properties = inputNames
      .map((name) => {
        const parameter = asObject(templateParameters[name]);
        return `  ${typescriptProperty(name)}: ${workflowInputType(parameter.type)};`;
      })
      .join("\n");
    const body = renderWorkflowValue(definition, 1);
    const component = resource.requiredBy[0] ?? "workflow";
    files.set(
      `components/${component}/workflow.ts`,
      `import { fn, type ExpressionOrValue } from "@azure/provisioning-core";

export interface ${interfaceName} {
${properties}
}

export function ${functionName}(inputs: ${interfaceName}) {
  return ${body};
}
`,
    );
  }
  return files;
}

export function renderGraphProvisioningHelper(): string {
  return `import { renderBicepFile, type RenderedBicepFile } from "@azure/provisioning-bicep";
import { type ExpressionOrValue, type Stack } from "@azure/provisioning-core";
import {
  serialize,
  serializeValue,
  type SerializableValue,
} from "@azure/provisioning-serialization";
import type {
  ResourceDeclarationNode,
  SerializationDocument,
} from "@azure/provisioning-serialization-ast";

const graphExtension =
  "br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:1.0.0";

export interface GraphResourceDefinition {
  readonly identifier: string;
  readonly type: string;
  readonly body: Readonly<Record<string, SerializableValue>>;
  readonly condition?: ExpressionOrValue<boolean>;
}

export interface RenderedGraphStack {
  readonly outputJson: SerializationDocument;
  readonly main: RenderedBicepFile;
}

export function renderGraphStack(
  stack: Stack,
  resources: readonly GraphResourceDefinition[],
): RenderedGraphStack {
  const serialized = serialize([stack]);
  const [infra] = serialized.infras;
  if (infra === undefined) {
    throw new Error("Graph provisioning produced no infrastructure entry.");
  }
  const graphResources = Object.fromEntries(
    resources.map((resource) => [resource.identifier, createGraphResource(resource)]),
  );
  const graphInfra = {
    ...infra,
    resources: { ...infra.resources, ...graphResources },
    extensions: [...(infra.extensions ?? []), { path: graphExtension }],
  };
  const outputJson: SerializationDocument = { infras: [graphInfra] };
  return { outputJson, main: renderBicepFile(graphInfra) };
}

function createGraphResource(
  resource: GraphResourceDefinition,
): ResourceDeclarationNode {
  const body = serializeValue(resource.body);
  if (body.kind !== "object") {
    throw new Error(\`Graph resource '\${resource.identifier}' must be an object.\`);
  }
  return {
    bicepIdentifier: resource.identifier,
    type: resource.type,
    apiVersion: "v1.0",
    existing: false,
    value:
      resource.condition === undefined
        ? body
        : {
            kind: "if-condition",
            condition: serializeValue(resource.condition),
            body,
          },
  };
}
`;
}

export function renderEntraIdentityBootstrapSource(
  options: ProvisioningSourceOptions,
): string {
  const plans = entraApplicationPlans(options);
  if (plans.length === 0) return "";
  const declarations = plans.map((plan) => `const ${plan.base}ApplicationUniqueName = stack.parameters.add(
  ${JSON.stringify(`${plan.base}ApplicationUniqueName`)},
  "string",
);
const ${plan.base}ApplicationAppId = bicepRef<string>(${JSON.stringify(`${plan.base}Application.appId`)});
const ${plan.base}ApplicationObjectId = bicepRef<string>(${JSON.stringify(`${plan.base}Application.id`)});
const ${plan.base}ServicePrincipalId = bicepRef<string>(${JSON.stringify(`${plan.base}ServicePrincipal.id`)});

stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_APP_ID"))}, "string", ${plan.base}ApplicationAppId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_OBJECT_ID"))}, "string", ${plan.base}ApplicationObjectId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "SERVICE_PRINCIPAL_ID"))}, "string", ${plan.base}ServicePrincipalId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_UNIQUE_NAME"))}, "string", ${plan.base}ApplicationUniqueName);`).join("\n\n");
  const resources = plans.map((plan) => `  {
    identifier: ${JSON.stringify(`${plan.base}Application`)},
    type: "Microsoft.Graph/applications",
    body: {
      uniqueName: ${plan.base}ApplicationUniqueName,
      displayName: ${JSON.stringify(plan.displayName)},
      signInAudience: "AzureADMyOrg",
      serviceManagementReference: ${JSON.stringify(options.serviceManagementReference)},
    },
  },
  {
    identifier: ${JSON.stringify(`${plan.base}ServicePrincipal`)},
    type: "Microsoft.Graph/servicePrincipals",
    body: { appId: ${plan.base}ApplicationAppId },
  },`).join("\n");
  const bindings = plans.map((plan) =>
    `    ${plan.base}ApplicationUniqueName: fn.readEnvironmentVariable(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_UNIQUE_NAME"))}),`
  ).join("\n");
  return `import {
  bicepRef,
  createBicepParameterFile,
  renderBicepFile,
} from "@azure/provisioning-bicep";
import { fn, Stack } from "@azure/provisioning-core";

import { renderGraphStack } from "./graph-provisioning.js";

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
  renderBicepFile(parameterFile),
];
`;
}

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
  renderBicepFile,
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
  renderBicepFile(parameterFile),
];
`;
}

export function renderEntraIdentityLifecycleSource(
  options: ProvisioningSourceOptions,
): string {
  const plans = entraApplicationPlans(options);
  if (plans.length === 0) return "";
  const descriptors = plans.map((plan) => `  {
    resourceId: ${JSON.stringify(plan.resource.id)},
    displayName: ${JSON.stringify(plan.displayName)},
    uniqueNamePrefix: ${JSON.stringify(plan.uniqueNamePrefix)},
    delegatedPermissionScope: ${JSON.stringify(plan.delegatedPermissionScope)},
    applicationAppIdOutput: ${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_APP_ID"))},
    applicationObjectIdOutput: ${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_OBJECT_ID"))},
    servicePrincipalIdOutput: ${JSON.stringify(entraOutput(plan.resource.id, "SERVICE_PRINCIPAL_ID"))},
    applicationUniqueNameOutput: ${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_UNIQUE_NAME"))},
    delegatedScopeIdOutput: ${JSON.stringify(entraOutput(plan.resource.id, "DELEGATED_SCOPE_ID"))},
    applicationRoleIdOutput: ${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_ROLE_ID"))},
    preAuthorizeClientsOutput: ${JSON.stringify(entraOutput(plan.resource.id, "PREAUTHORIZE_CLIENTS"))},
    existingPermissionScopesOutput: ${JSON.stringify(entraOutput(plan.resource.id, "EXISTING_PERMISSION_SCOPES"))},
    existingApplicationRolesOutput: ${JSON.stringify(entraOutput(plan.resource.id, "EXISTING_APPLICATION_ROLES"))},
    callerPrincipalOutputs: ${JSON.stringify(plan.callerPrincipalOutputs)},
  },`).join("\n");
  return `import {
  captureAzureJson,
  runAzure,
  type Deployment,
} from "imperative-deploy";
import { persistEnvironment, requiredEnv } from "../../runtime/environment.js";
import {
  generatedIdentityProject,
  identityBootstrapEntrypoint,
  identityConfigurationEntrypoint,
} from "../../runtime/paths.js";

interface ApplicationSummary {
  appId: string;
  uniqueName?: string;
}

interface ApplicationDefinition extends ApplicationSummary {
  appRoles?: ApplicationRole[];
  api?: { oauth2PermissionScopes?: PermissionScope[] };
}

interface PermissionScope {
  adminConsentDescription?: string;
  adminConsentDisplayName?: string;
  id: string;
  isEnabled?: boolean;
  type?: string;
  userConsentDescription?: string;
  userConsentDisplayName?: string;
  value?: string;
}

interface ApplicationRole {
  allowedMemberTypes?: string[];
  description?: string;
  displayName?: string;
  id: string;
  isEnabled?: boolean;
  value?: string;
}

const identityDeploymentName = ${JSON.stringify(`${options.requirements.solution.name}-identity`)};
const applicationPlans = [
${descriptors}
] as const;

export async function ensureEntraApplications(
  deployment: Deployment,
): Promise<void> {
  const suffix = deployment.dryRun
    ? process.env.DEPLOY_RESOURCE_SUFFIX?.trim() || "dryrun"
    : requiredEnv("DEPLOY_RESOURCE_SUFFIX");
  const environmentValues: Record<string, string> = {};
  for (const plan of applicationPlans) {
    const desiredUniqueName = plan.uniqueNamePrefix + suffix;
    environmentValues[plan.applicationUniqueNameOutput] = deployment.dryRun
      ? desiredUniqueName
      : await resolveApplicationUniqueName(
          deployment,
          plan.applicationAppIdOutput,
          plan.displayName,
          desiredUniqueName,
        );
  }
  const outputs = await deployment.provision("server application registration", {
    entrypoint: identityBootstrapEntrypoint,
    outputDirectory: generatedIdentityProject,
    deploymentName: identityDeploymentName,
    scope: "subscription",
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
    environmentValues,
  });
  if (deployment.dryRun) {
    const dryRunOutputs: Record<string, string> = {};
    for (const plan of applicationPlans) {
      Object.assign(dryRunOutputs, {
        [plan.applicationAppIdOutput]:
          process.env[plan.applicationAppIdOutput] ??
          "00000000-0000-4000-8000-000000000010",
        [plan.applicationObjectIdOutput]:
          process.env[plan.applicationObjectIdOutput] ??
          "00000000-0000-4000-9000-000000000010",
        [plan.servicePrincipalIdOutput]:
          process.env[plan.servicePrincipalIdOutput] ??
          "00000000-0000-4000-a000-000000000010",
        [plan.applicationUniqueNameOutput]:
          environmentValues[plan.applicationUniqueNameOutput]!,
      });
    }
    Object.assign(process.env, dryRunOutputs);
    return;
  }
  await persistEnvironment(requiredEnv("AZURE_ENV_NAME"), outputs);
}

export async function configureEntraApplications(
  deployment: Deployment,
): Promise<void> {
  const environmentValues: Record<string, string> = {};
  for (const plan of applicationPlans) {
    const appId = requiredEnv(plan.applicationAppIdOutput);
    const application = deployment.dryRun
      ? undefined
      : await captureAzureJson<ApplicationDefinition>(deployment, [
          "ad",
          "app",
          "show",
          "--id",
          appId,
        ]);
    const delegatedScope = application?.api?.oauth2PermissionScopes?.find(
      (scope) => scope.value === plan.delegatedPermissionScope,
    );
    const applicationRole = application?.appRoles?.find(
      (role) => role.value === "access_as_application",
    );
    Object.assign(environmentValues, {
      [plan.delegatedScopeIdOutput]: delegatedScope?.id ?? "",
      [plan.applicationRoleIdOutput]: applicationRole?.id ?? "",
      [plan.existingPermissionScopesOutput]: JSON.stringify(
        (application?.api?.oauth2PermissionScopes ?? [])
          .filter((scope) => scope.value !== plan.delegatedPermissionScope)
          .map(normalizePermissionScope),
      ),
      [plan.existingApplicationRolesOutput]: JSON.stringify(
        (application?.appRoles ?? [])
          .filter((role) => role.value !== "access_as_application")
          .map(normalizeApplicationRole),
      ),
    });
    for (const output of plan.callerPrincipalOutputs) {
      environmentValues[output] = process.env[output]?.trim() ?? "";
    }
  }
  const provisionPermissions = (
    name: string,
    preAuthorizeClients: boolean,
  ) => deployment.provision(name, {
    entrypoint: identityConfigurationEntrypoint,
    outputDirectory: generatedIdentityProject,
    deploymentName: identityDeploymentName,
    scope: "subscription",
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
    environmentValues: {
      ...environmentValues,
      ...Object.fromEntries(
        applicationPlans.map((plan) => [
          plan.preAuthorizeClientsOutput,
          preAuthorizeClients ? "true" : "false",
        ]),
      ),
    },
  });
  await provisionPermissions("server application permissions", false);
  const outputs = await provisionPermissions(
    "server application pre-authorization",
    true,
  );
  if (!deployment.dryRun) {
    await persistEnvironment(requiredEnv("AZURE_ENV_NAME"), outputs);
  }
}

async function resolveApplicationUniqueName(
  deployment: Deployment,
  appIdOutput: string,
  displayName: string,
  desiredUniqueName: string,
): Promise<string> {
  const persistedAppId = process.env[appIdOutput]?.trim();
  let application = persistedAppId
    ? await captureAzureJson<ApplicationSummary>(deployment, [
        "ad",
        "app",
        "show",
        "--id",
        persistedAppId,
      ]).catch(() => undefined)
    : undefined;
  if (!application) {
    const escaped = desiredUniqueName.replaceAll("'", "''");
    application = (
      await captureAzureJson<ApplicationSummary[]>(deployment, [
        "ad",
        "app",
        "list",
        "--filter",
        \`uniqueName eq '\${escaped}'\`,
      ])
    )[0];
  }
  if (!application) {
    application = (
      await captureAzureJson<ApplicationSummary[]>(deployment, [
        "ad",
        "app",
        "list",
        "--display-name",
        displayName,
      ])
    )[0];
  }
  if (!application) return desiredUniqueName;
  if (application.uniqueName?.trim()) return application.uniqueName.trim();
  await runAzure(deployment, [
    "ad",
    "app",
    "update",
    "--id",
    application.appId,
    "--set",
    \`uniqueName=\${desiredUniqueName}\`,
    "--output",
    "none",
  ]);
  return desiredUniqueName;
}

function normalizePermissionScope(scope: PermissionScope): Record<string, unknown> {
  return {
    id: scope.id,
    value: scope.value ?? "",
    type: scope.type ?? "User",
    isEnabled: scope.isEnabled ?? true,
    adminConsentDisplayName: scope.adminConsentDisplayName ?? "",
    adminConsentDescription: scope.adminConsentDescription ?? "",
    userConsentDisplayName: scope.userConsentDisplayName ?? "",
    userConsentDescription: scope.userConsentDescription ?? "",
  };
}

function normalizeApplicationRole(role: ApplicationRole): Record<string, unknown> {
  return {
    id: role.id,
    value: role.value ?? "",
    displayName: role.displayName ?? "",
    description: role.description ?? "",
    isEnabled: role.isEnabled ?? true,
    allowedMemberTypes: role.allowedMemberTypes ?? [],
  };
}
`;
}

export function provisioningDependencies(
  outputDirectory: string,
  repositoryRoot: string,
): Readonly<Record<string, string>> {
  const vendorRoot = relativePath(
    outputDirectory,
    `${repositoryRoot}/vendor`,
  );
  const packages = [
    "appconfiguration",
    "applicationinsights",
    "appservice",
    "authorization",
    "bicep",
    "botservice",
    "cognitiveservices",
    "container-registry",
    "core",
    "cosmosdb",
    "logic",
    "managed-identity",
    "operationalinsights",
    "serialization",
    "serialization-ast",
    "storage",
  ];
  return Object.fromEntries(
    packages.map((name) => [
      `@azure/provisioning-${name}`,
      `file:${vendorRoot}/azure-provisioning-${name}-0.1.0.tgz`,
    ]),
  );
}

class ProvisioningSourceRenderer {
  readonly #options: ProvisioningSourceOptions;
  readonly #resources: readonly ResourceRequirement[];
  readonly #owner?: string;
  readonly #componentKinds: ReadonlyMap<string, string | undefined>;
  readonly #outputs = new Map<string, string>();
  readonly #externalOutputs = new Map<string, string>();
  readonly #sections: string[] = [];
  readonly #graphResources: string[] = [];
  readonly #parameters: string[] = [];
  readonly #parameterBindings: string[] = [];
  readonly #inputParameters = new Map<string, string>();
  readonly #existingResources = new Set<string>();
  readonly #workflowPlans: WorkflowPlan[] = [];

  constructor(options: ProvisioningSourceOptions, owner?: string) {
    this.#options = options;
    this.#resources = options.requirements.resources;
    this.#owner = owner;
    this.#componentKinds = new Map(
      options.solution.components.map((component) => [component.id, component.kind]),
    );
    this.#registerOutputs();
    if (owner === undefined || owner === "shared") {
      this.#outputs.set("DEPLOY_RESOURCE_SUFFIX", "suffix");
    }
    this.#prepareWorkflowPlans();
  }

  render(): string {
    this.#renderRegistry();
    this.#renderBotIdentities();
    this.#renderAiProjects();
    this.#renderModelDeployments();
    this.#renderDocumentDatabases();
    this.#renderObjectStorage();
    this.#renderConfigurationStores();
    this.#renderMonitoring();
    this.#renderContainers();
    this.#renderBots();
    this.#renderConnections();
    this.#renderWorkflows();
    this.#renderConfigurationValues();
    this.#renderAccess();
    const body = [...this.#sections];
    this.#sections.length = 0;
    this.#renderPrelude();
    this.#sections.push(...body);
    this.#renderOutputs();
    this.#renderFooter();
    return this.#sections.join("\n");
  }

  #renderPrelude(): void {
    const workflowImports = this.#workflowPlans
      .map(
        (plan) =>
          `import { ${plan.functionName} } from ${JSON.stringify(plan.importPath)};`,
      )
      .join("\n");
    this.#sections.push(`import {
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
import { renderGraphStack } from ${JSON.stringify(this.#owner && this.#owner !== "shared" ? "../shared/graph-provisioning.js" : "./graph-provisioning.js")};
${workflowImports}

export const solutionName = ${JSON.stringify(this.#options.requirements.solution.name)};

const stack = new Stack("main", { targetScope: "resourceGroup" });
const location = stack.parameters.add("location", "string");
${this.#parameters.join("\n")}
const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);
`);
  }

  #renderRegistry(): void {
    if (!this.#resources.some((resource) => resource.kind === "container-host")) return;
    if (this.#owner !== undefined && this.#owner !== "shared") {
      if (!this.#ofKind("container-host").some((resource) => !this.#isHosted(resource))) {
        return;
      }
      const registryName = this.#input("DEPLOY_REGISTRY_NAME");
      this.#sections.push(`const deploymentRegistry = new Registry(stack, {
  name: ${registryName},
  existing: true,
});
`);
      return;
    }
    this.#sections.push(`const deploymentRegistry = new Registry(stack, {
  name: fn.concat(${JSON.stringify(alphanumericPrefix(this.#solutionName(), "registry", 44))}, suffix),
  location,
  sku: { name: "Basic" },
  properties: { adminUserEnabled: false },
});
`);
    this.#outputs.set("DEPLOY_REGISTRY_NAME", "deploymentRegistry.name");
    this.#outputs.set(
      "AZURE_CONTAINER_REGISTRY_ENDPOINT",
      "deploymentRegistry.properties.loginServer as any",
    );
  }

  #renderBotIdentities(): void {
    for (const resource of this.#ofKind("bot-identity")) {
      const base = identifier(resource.id);
      this.#sections.push(`const ${base}Identity = new UserAssignedIdentity(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), resource.id, 116))}, suffix),
  location,
});
`);
    }
  }

  #renderAiProjects(): void {
    for (const resource of this.#ofKind("ai-project")) {
      const base = identifier(resource.id);
      const configuration = asObject(resource.configuration);
      const model = stringValue(configuration.model, "gpt-4.1-mini");
      const aiLocation = this.#input(
        "AZURE_AI_LOCATION",
        "AZURE_AI_LOCATION",
        "eastus",
      );
      const aiLocationSuffix = `${base}LocationSuffix`;
      const hasExplicitModelDeployment = this.#resources.some(
        (candidate) =>
          candidate.kind === "model-deployment" && candidate.parent === resource.id,
      );
      this.#sections.push(`const ${aiLocationSuffix} = stack.variables.add(
  ${JSON.stringify(aiLocationSuffix)},
  fn.substring(fn.uniqueString(fn.resourceGroup().id, ${aiLocation}), 0, 6),
);

const ${base}Account = new Account(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), `${resource.id}-ai`, 52))}, ${aiLocationSuffix}),
  location: ${aiLocation},
  kind: "AIServices",
  sku: { name: "S0" },
  identity: { type: "SystemAssigned" },
  properties: {
    customSubDomainName: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), `${resource.id}-ai`, 52))}, ${aiLocationSuffix}),
    allowProjectManagement: true,
    publicNetworkAccess: "Enabled",
    disableLocalAuth: true,
  } as any,
});

const ${base}Project = new Project(${base}Account, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), `${resource.id}-project`, 52))}, ${aiLocationSuffix}),
  location: ${aiLocation},
  identity: { type: "SystemAssigned" },
  properties: {} as any,
});

${hasExplicitModelDeployment ? "" : `
new ModelDeployment(${base}Account, {
  name: ${JSON.stringify(model)},
  sku: { name: "GlobalStandard", capacity: 1 },
  properties: {
    model: {
      format: "OpenAI",
      name: ${JSON.stringify(model)},
      version: ${JSON.stringify(defaultModelVersion())},
    },
    versionUpgradeOption: "OnceNewDefaultVersionAvailable",
  } as any,
});
`}
${this.#hasRegistry() ? `
new RoleAssignment(deploymentRegistry, {
  name: fn.guid(
    deploymentRegistry.id,
    ${base}Project.id,
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "7f951dda-4ed3-4680-a7ca-43fe172d538d",
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "7f951dda-4ed3-4680-a7ca-43fe172d538d",
    ),
    principalId: ${base}Project.identity.principalId as any,
    principalType: "ServicePrincipal",
  },
});
` : ""}
`);
      this.#outputs.set("AZURE_AI_PROJECT_ID", `${base}Project.id`);
      this.#outputs.set("AI_RESOURCE_NAME", `${base}Account.name`);
      this.#outputs.set("AI_PROJECT_NAME", `${base}Project.name`);
      this.#outputs.set(
        "FOUNDRY_PROJECT_ENDPOINT",
        `fn.concat("https://", ${base}Account.name, ".services.ai.azure.com/api/projects/", ${base}Project.name)`,
      );
    }
  }

  #renderModelDeployments(): void {
    for (const resource of this.#ofKind("model-deployment")) {
      const parentId = stringValue(resource.parent, "");
      const parent = this.#resources.find(
        (candidate) => candidate.id === parentId && candidate.kind === "ai-project",
      );
      if (!parent) {
        throw new Error(
          `Model deployment '${resource.id}' references unknown AI project '${parentId}'.`,
        );
      }
      this.#ensureExistingResource(parent);
      const configuration = asObject(resource.configuration);
      const deploymentName = modelDeploymentName(resource);
      const model = stringValue(configuration.model, deploymentName);
      const version = stringValue(
        configuration.version,
        defaultModelVersion(),
      );
      const parentBase = identifier(parent.id);
      this.#sections.push(`new ModelDeployment(${parentBase}Account, {
  name: ${JSON.stringify(deploymentName)},
  sku: { name: "GlobalStandard", capacity: 1 },
  properties: {
    model: {
      format: "OpenAI",
      name: ${JSON.stringify(model)},
      version: ${JSON.stringify(version)},
    },
    versionUpgradeOption: "OnceNewDefaultVersionAvailable",
  } as any,
});
`);
    }
  }

  #renderDocumentDatabases(): void {
    for (const resource of this.#ofKind("document-database")) {
      const base = identifier(resource.id);
      const configuration = asObject(resource.configuration);
      const databaseName = stringValue(configuration.database, resource.id);
      this.#sections.push(`const ${base}Account = new DatabaseAccount(stack, {
  name: fn.concat(${JSON.stringify(alphanumericPrefix(this.#solutionName(), resource.id, 32))}, suffix),
  location,
  kind: "GlobalDocumentDB",
  properties: {
    databaseAccountOfferType: "Standard",
    disableLocalAuth: true,
    publicNetworkAccess: "Enabled",
    minimalTlsVersion: "Tls12",
    consistencyPolicy: { defaultConsistencyLevel: "Session" },
    locations: [
      { locationName: location, failoverPriority: 0, isZoneRedundant: false },
    ],
  } as any,
});

const ${base}Database = new SqlDatabase(${base}Account, {
  name: ${JSON.stringify(databaseName)},
  properties: {
    resource: { id: ${JSON.stringify(databaseName)} },
    options: { throughput: ${positiveInteger(configuration.throughput, 400)} },
  } as any,
});
`);
      this.#outputs.set(
        implementationOutput(resource.id, "NAME"),
        `${base}Account.name`,
      );
      const containers = arrayValue(configuration.containers);
      containers.forEach((containerValue, index) => {
        const container = requiredObject(
          containerValue,
          `${resource.id}.configuration.containers[${index}]`,
        );
        const name = requiredString(container.name, `${resource.id}.containers[${index}].name`);
        const partitionKey = requiredString(
          container.partitionKey,
          `${resource.id}.containers[${index}].partitionKey`,
        );
        this.#sections.push(`new CosmosContainer(${base}Database, {
  name: ${JSON.stringify(name)},
  properties: {
    resource: {
      id: ${JSON.stringify(name)},
      partitionKey: {
        paths: [${JSON.stringify(partitionKey)}],
        kind: "Hash",
        version: 2,
      },
    },
  } as any,
});
`);
      });
    }
  }

  #renderObjectStorage(): void {
    for (const resource of this.#ofKind("object-storage")) {
      const base = identifier(resource.id);
      const configuration = asObject(resource.configuration);
      this.#sections.push(`const ${base}Account = new StorageAccount(stack, {
  name: fn.concat(${JSON.stringify(alphanumericPrefix(this.#solutionName(), resource.id, 18))}, suffix),
  location,
  kind: "StorageV2",
  sku: { name: "Standard_LRS" },
  properties: {
    minimumTlsVersion: "TLS1_2",
    allowBlobPublicAccess: false,
    allowSharedKeyAccess: false,
    supportsHttpsTrafficOnly: true,
  } as any,
});

const ${base}BlobService = new BlobService(${base}Account, {});
`);
      this.#outputs.set(
        implementationOutput(resource.id, "NAME"),
        `${base}Account.name`,
      );
      for (const nameValue of arrayValue(configuration.containers)) {
        const name = requiredString(nameValue, `${resource.id}.configuration.containers[]`);
        this.#sections.push(`new StorageContainer(${base}BlobService, {
  name: ${JSON.stringify(name)},
  properties: { publicAccess: "None" },
});
`);
      }
    }
  }

  #renderConfigurationStores(): void {
    for (const resource of this.#ofKind("configuration-store")) {
      const base = identifier(resource.id);
      this.#sections.push(`const ${base}Store = new ConfigurationStore(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), resource.id, 42))}, suffix),
  location,
  sku: { name: "standard" },
  properties: {
    disableLocalAuth: true,
            publicNetworkAccess: "Enabled",
            dataPlaneProxy: { authenticationMode: "Pass-through" },
  } as any,
});
`);
      this.#outputs.set(
        implementationOutput(resource.id, "NAME"),
        `${base}Store.name`,
      );
    }
  }

  #renderConfigurationValues(): void {
    for (const resource of this.#resources.filter(
      (candidate) => candidate.kind === "configuration-store",
    )) {
      const base = identifier(resource.id);
      const values = asObject(asObject(resource.configuration).values);
      const ownedValues = Object.entries(values).filter(
        ([, value]) => this.#configurationValueOwner(value) === this.#effectiveOwner(),
      );
      if (ownedValues.length === 0) continue;
      if (!this.#owns(resource)) this.#ensureExistingResource(resource);
      for (const [name, value] of ownedValues) {
        this.#sections.push(`new KeyValue(${base}Store, {
  name: ${JSON.stringify(name)},
  properties: {
    value: ${this.#renderValue(value)},
  },
});
`);
      }
    }
  }

  #renderMonitoring(): void {
    for (const resource of this.#ofKind("application-monitoring")) {
      const base = identifier(resource.id);
      this.#sections.push(`const ${base}Workspace = new Workspace(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), `${resource.id}-logs`, 55))}, suffix),
  location,
  properties: {
    retentionInDays: 30,
    sku: { name: "PerGB2018" },
  } as any,
});

const ${base}Insights = new ApplicationInsightsComponent(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), resource.id, 92))}, suffix),
  location,
  kind: "web",
  properties: {
    Application_Type: "web",
    WorkspaceResourceId: ${base}Workspace.id as any,
  },
});
`);
      this.#outputs.set(
        implementationOutput(resource.id, "NAME"),
        `${base}Insights.name`,
      );
    }
  }

  #renderContainers(): void {
    for (const resource of this.#ofKind("container-host")) {
      if (this.#isHosted(resource)) continue;
      const base = identifier(resource.id);
      const runtimeSettings = asObject(asObject(resource.configuration).runtimeSettings);
      const entraAuthentication = microsoftEntraAuthentication(resource);
      const botIdentity = this.#ofKind("bot-identity")[0];
      const attachedIdentity =
        resource.authentication === "bot-framework" && botIdentity
          ? `fn.union(\n      fn.json(fn.concat('{"', ${base}Identity.id, '":{}}')),\n      fn.json(fn.concat('{"', ${identifier(botIdentity.id)}Identity.id, '":{}}')),\n    ) as any`
          : `fn.json(fn.concat('{"', ${base}Identity.id, '":{}}')) as any`;
      if (entraAuthentication) {
        const audienceName = `${base}Audience`;
        const appIdName = `${base}ApplicationAppId`;
        const applicationAppId = this.#input(
          entraOutput(resource.id, "APPLICATION_APP_ID"),
          appIdName,
        );
        this.#sections.push(`const ${appIdName} = ${applicationAppId};
const ${audienceName} = fn.concat("api://", ${appIdName});
`);
      }
      const appSettings = [
        `{ name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE", value: "false" }`,
        `{ name: "WEBSITES_PORT", value: ${JSON.stringify(String(numberValue(resource.containerPort, 8080)))} }`,
        ...(entraAuthentication
          ? [`{ name: "AZURE_CLIENT_ID", value: ${base}Identity.properties.clientId as any }`]
          : []),
        ...Object.entries(runtimeSettings).map(
          ([name, value]) =>
            `{ name: ${JSON.stringify(name)}, value: ${this.#renderValue(value)} }`,
        ),
      ];
      this.#sections.push(`const ${base}Identity = new UserAssignedIdentity(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), `${resource.id}-identity`, 116))}, suffix),
  location,
});

const ${base}Plan = new AppServicePlan(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedQualifiedPrefix(this.#solutionName(), resource.id, "p", 32))}, suffix),
  location,
  kind: "linux",
  sku: { name: "B1", tier: "Basic", capacity: 1 },
  properties: { reserved: true },
});

const ${base}Site = new Site(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), resource.id, 52))}, suffix),
  location,
  kind: "app,linux,container",
  tags: { "azd-service-name": ${JSON.stringify(resource.requiredBy[0] ?? resource.id)} },
  identity: {
    type: "UserAssigned",
    userAssignedIdentities: ${attachedIdentity},
  },
  properties: {
    serverFarmId: ${base}Plan.id as any,
    httpsOnly: true,
    siteConfig: {
      linuxFxVersion: "DOCKER|mcr.microsoft.com/azuredocs/aci-helloworld:latest",
      alwaysOn: true,
      acrUseManagedIdentityCreds: true,
      acrUserManagedIdentityID: ${base}Identity.properties.clientId as any,
      ${typeof resource.healthPath === "string" ? `healthCheckPath: ${JSON.stringify(resource.healthPath)},\n      ` : ""}appSettings: [
        ${appSettings.join(",\n        ")}
      ],
    },
  } as any,
});
`);
      if (entraAuthentication) {
        this.#sections.push(`new SiteConfigAuthsettingsV2(${base}Site, {
  properties: {
    platform: { enabled: true, runtimeVersion: "~1" },
    globalValidation: {
      requireAuthentication: true,
      unauthenticatedClientAction: "Return401",
${typeof resource.healthPath === "string" ? `      excludedPaths: [${JSON.stringify(resource.healthPath)}],\n` : ""}
    },
    identityProviders: {
      azureActiveDirectory: {
        enabled: true,
        registration: {
          clientId: ${base}ApplicationAppId,
          openIdIssuer: fn.concat(
            (fn.environment() as any).authentication.loginEndpoint,
            fn.tenant().tenantId,
            "/v2.0",
          ) as any,
        },
        validation: {
          allowedAudiences: [${base}ApplicationAppId, ${base}Audience],
        },
      },
    },
    login: { tokenStore: { enabled: true } },
  } as any,
});
`);
      }
      if (!this.#hasExplicitRegistryAccess(resource)) {
        this.#sections.push(`new RoleAssignment(deploymentRegistry, {
  name: fn.guid(
    deploymentRegistry.id,
    ${base}Identity.id,
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "7f951dda-4ed3-4680-a7ca-43fe172d538d",
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      "7f951dda-4ed3-4680-a7ca-43fe172d538d",
    ),
    principalId: ${base}Identity.properties.principalId as any,
    principalType: "ServicePrincipal",
  },
});
`);
      }
      this.#outputs.set(implementationOutput(resource.id, "NAME"), `${base}Site.name`);
    }
  }

  #renderBots(): void {
    for (const resource of this.#ofKind("bot-identity")) {
      const base = identifier(resource.id);
      const frontend = this.#outputs.get("frontendBaseUrl") ?? JSON.stringify("");
      this.#sections.push(`const ${base}Bot = new Bot(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(this.#solutionName(), `${resource.id}-bot`, 56))}, suffix),
  location: "global",
  kind: "azurebot",
  sku: { name: "F0" },
  properties: {
    displayName: ${JSON.stringify(this.#solutionName())},
    endpoint: fn.concat(${frontend}, "/api/messages"),
    msaAppId: ${base}Identity.properties.clientId as any,
    msaAppTenantId: ${base}Identity.properties.tenantId as any,
    msaAppType: "UserAssignedMSI",
    msaAppMSIResourceId: ${base}Identity.id as any,
  },
});

new Channel(${base}Bot, {
  name: "MsTeamsChannel",
  location: "global",
  properties: { channelName: "MsTeamsChannel", location: "global" } as any,
});
`);
    }
  }

  #renderConnections(): void {
    for (const resource of this.#ofKind("authorized-api-connection")) {
      const base = identifier(resource.id);
      const createParameter = `create${pascalCase(resource.id)}`;
      this.#sections.push(`const ${base}ManagedApiId = fn.concat(
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
      api: { id: ${base}ManagedApiId },
      parameterValues: {},
    },
  },
  { condition: ${createParameter} },
);
`);
      this.#outputs.set(implementationOutput(resource.id, "NAME"), JSON.stringify("teams"));
    }
  }

  #renderWorkflows(): void {
    for (const plan of this.#workflowPlans) {
      const base = identifier(plan.resource.id);
      const parameterValues = asObject(asObject(plan.resource.parameters).parameters);
      const identities = asObject(asObject(parameterValues.userAssignedIdentities).value);
      const identityExpressions = Object.keys(identities).map((key) => this.#renderValue(key));
      const identity =
        identityExpressions.length === 0
          ? "undefined"
          : identityExpressions
              .map((expression) => `fn.json(fn.concat('{"', ${expression}, '":{}}'))`)
              .reduce((left, right) => `fn.union(${left}, ${right})`);
      const identityType =
        identityExpressions.length === 0
          ? "SystemAssigned"
          : plan.resource.identity === "user-assigned"
            ? "UserAssigned"
            : "SystemAssigned,UserAssigned";
      const teamsConnectionId = this.#outputs.get("teamsConnectionResourceId") ??
        `fn.resourceId("Microsoft.Web/connections", "teams")`;
      const connectionResource = this.#ofKind("authorized-api-connection")[0];
      const managedApiId = connectionResource
        ? `${identifier(connectionResource.id)}ManagedApiId`
        : `fn.concat("/subscriptions/", fn.subscription().subscriptionId, "/providers/Microsoft.Web/locations/", location, "/managedApis/teams")`;
      const inputNames = collectWorkflowInputs(plan.definition);
      const inputLines = inputNames
        .map((name) => {
          const expression = plan.parameterExpressions.get(name);
          if (!expression) {
            throw new Error(
              `Workflow '${plan.resource.id}' has no expression for parameter '${name}'.`,
            );
          }
          return `    ${typescriptProperty(name)}: ${expression},`;
        })
        .join("\n");
      this.#sections.push(`const ${base}Name = fn.concat(
  ${JSON.stringify(hyphenatedPrefix(this.#solutionName(), plan.resource.id, 62))},
  suffix,
);

const ${base} = new Workflow(stack, {
  name: ${base}Name,
  location,
  identity: {
    type: ${JSON.stringify(identityType)},
    ${identityExpressions.length > 0 ? `userAssignedIdentities: ${identity} as any,` : ""}
  },
  properties: {
    state: "Disabled",
    definition: ${plan.functionName}({
${inputLines}
    }) as any,
    parameters: {
      $connections: {
        value: {
          teams: {
            connectionId: ${teamsConnectionId},
            connectionName: "teams",
            connectionProperties: {},
            id: ${managedApiId},
          },
        },
      },
    },
  } as any,
},
${plan.deploymentCondition ? `  { condition: ${plan.deploymentCondition} },` : ""}
);
`);
      this.#outputs.set(implementationOutput(plan.resource.id, "NAME"), `${base}Name`);
    }
  }

  #renderAccess(): void {
    for (const resource of this.#resources) {
      for (const grant of accessValues(resource)) {
        const producer = this.#resources.find((candidate) =>
          candidate.produces?.includes(grant.principalOutput),
        );
        if (!producer) {
          throw new Error(
            `Resource '${resource.id}' references unknown principal '${grant.principalOutput}'.`,
          );
        }
        if (this.#isHosted(producer)) {
          if (this.#owns(resource)) {
            const scope = this.#scopeExpression(resource);
            this.#outputs.set(
              implementationOutput(resource.id, "ACCESS_SCOPE"),
              `${scope}.id`,
            );
          }
          continue;
        }
        if (
          this.#owner !== undefined &&
          resourceOwner(producer) !== this.#owner
        ) {
          continue;
        }
        const scope = this.#scopeExpression(resource);
        const principalId = this.#outputs.get(grant.principalOutput);
        const principalKey = this.#principalKey(producer);
        if (!principalId) {
          throw new Error(`Principal output '${grant.principalOutput}' is unavailable.`);
        }
        if (grant.role === "Cosmos DB Built-in Data Contributor") {
          const base = identifier(resource.id);
          this.#sections.push(`new SqlRoleAssignment(${base}Account, {
  name: fn.guid(
    ${base}Account.id,
    ${principalKey},
    "00000000-0000-0000-0000-000000000002",
  ),
  properties: {
    roleDefinitionId: fn.concat(
      ${base}Account.id,
      "/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002",
    ) as any,
    principalId: ${principalId} as any,
    scope: ${base}Account.id as any,
  },
});
`);
          continue;
        }
        const roleId = roleIds[grant.role];
        if (!roleId) throw new Error(`Unsupported Azure role '${grant.role}'.`);
        this.#sections.push(`new RoleAssignment(${scope}, {
  name: fn.guid(
    ${scope}.id,
    ${principalKey},
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      ${JSON.stringify(roleId)},
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      ${JSON.stringify(roleId)},
    ),
    principalId: ${principalId} as any,
    principalType: "ServicePrincipal",
  },
});
`);
      }
    }
  }

  #renderOutputs(): void {
    for (const [name, expression] of this.#outputs) {
      this.#sections.push(
        `stack.outputs.add(${JSON.stringify(name)}, "string", ${expression});`,
      );
    }
  }

  #renderFooter(): void {
    const bindings = [
      `    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),`,
      ...this.#parameterBindings.map((binding) => `    ${binding},`),
      ...this.#workflowPlans.flatMap((plan) =>
        plan.parameterBindings.map((binding) => `    ${binding},`),
      ),
    ].join("\n");
    const graphRendering =
      this.#graphResources.length > 0
        ? `const rendered = renderGraphStack(stack, [\n${this.#graphResources.join("\n")}\n]);\nexport const outputJson = rendered.outputJson;\nconst renderedStack = rendered.main;`
        : `export const outputJson = serialize([stack]);\nconst [renderedStack] = renderBicepFiles(outputJson);`;
    this.#sections.push(`const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
${bindings}
  },
});

${graphRendering}
if (renderedStack === undefined) {
  throw new Error("Generated provisioning produced no Bicep entry file.");
}
export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepFile(parameterFile),
];
`);
  }

  #registerOutputs(): void {
    for (const resource of this.#resources) {
      if (!this.#owns(resource)) continue;
      const base = identifier(resource.id);
      const lifecycleOutput =
        this.#owner !== undefined &&
        (resource.kind === "teams-application" || this.#isHosted(resource));
      if (lifecycleOutput) continue;
      for (const output of resource.produces ?? []) {
        this.#outputs.set(output, this.#outputExpression(resource, output, base));
      }
      if (resource.kind === "authorized-api-connection") {
        const parameterName = `create${pascalCase(resource.id)}`;
        this.#parameters.push(
          `const ${parameterName} = stack.parameters.add(${JSON.stringify(parameterName)}, "bool");`,
        );
        this.#parameterBindings.push(
          `${parameterName}: fn.eq(\n      fn.readEnvironmentVariable(${JSON.stringify(createResourceEnvironment(resource.id))}, "true"),\n      "true",\n    )`,
        );
      }
    }
  }

  #outputExpression(
    resource: ResourceRequirement,
    output: string,
    base: string,
  ): string {
    if (resource.kind === "workflow-host" && /IdentityPrincipalId$/i.test(output)) {
      const identity = `(${base} as any).identity.principalId as any`;
      const deploymentCondition = this.#workflowDeploymentCondition(resource);
      return deploymentCondition
        ? `fn.cond(${deploymentCondition}, ${identity}, "") as any`
        : identity;
    }
    const expressions: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      "ai-project": {
        foundryProjectEndpoint: `fn.concat("https://", ${base}Account.name, ".services.ai.azure.com/api/projects/", ${base}Project.name)`,
        agentName: JSON.stringify(`${this.#solutionName()}-agent`),
        agentVersion: this.#hasHostedAgent() ? JSON.stringify("") : JSON.stringify("1"),
      },
      "document-database": {
        cosmosEndpoint: `${base}Account.properties.documentEndpoint as any`,
        cosmosDatabase: `${base}Database.name`,
        cosmosAccountName: `${base}Account.name`,
        cosmosAccountResourceId: `${base}Account.id`,
      },
      "object-storage": {
        storageBlobEndpoint: `${base}Account.properties.primaryEndpoints!.blob as any`,
        storageAccountName: `${base}Account.name`,
        storageAccountResourceId: `${base}Account.id`,
      },
      "configuration-store": {
        appConfigurationEndpoint: `${base}Store.properties.endpoint as any`,
        appConfigurationName: `${base}Store.name`,
        appConfigurationResourceId: `${base}Store.id`,
      },
      "application-monitoring": {
        applicationInsightsConnectionString: `${base}Insights.properties.ConnectionString as any`,
        applicationInsightsName: `${base}Insights.name`,
      },
      "model-deployment": {
        foundryModelDeploymentName: JSON.stringify(modelDeploymentName(resource)),
      },
      "container-registry": {
        containerRegistryName: "deploymentRegistry.name",
        containerRegistryEndpoint: "deploymentRegistry.properties.loginServer as any",
      },
      "container-host": this.#containerOutputExpressions(resource, base),
      "bot-identity": {
        botClientId: `${base}Identity.properties.clientId as any`,
        botIdentityPrincipalId: `${base}Identity.properties.principalId as any`,
        botIdentityResourceId: `${base}Identity.id`,
        tenantId: `${base}Identity.properties.tenantId as any`,
      },
      "teams-application": {
        teamsAppId: `fn.guid(fn.subscription().subscriptionId, fn.resourceGroup().id, ${JSON.stringify(resource.id)})`,
      },
      "authorized-api-connection": {
        teamsConnectionResourceId: `fn.resourceId("Microsoft.Web/connections", "teams")`,
        connectionResourceId: `fn.resourceId("Microsoft.Web/connections", "teams")`,
      },
    };
    const expression = expressions[resource.kind]?.[output];
    if (!expression) {
      throw new Error(
        `Resource '${resource.id}' of kind '${resource.kind}' cannot produce '${output}'.`,
      );
    }
    return expression;
  }

  #containerOutputExpressions(
    resource: ResourceRequirement,
    base: string,
  ): Readonly<Record<string, string>> {
    if (this.#isHosted(resource)) {
      return {
        agentEndpoint: JSON.stringify(""),
        agentIdentityClientId: JSON.stringify(""),
        agentIdentityPrincipalId: JSON.stringify(""),
        agentIdentityResourceId: JSON.stringify(""),
      };
    }
    return {
      agentEndpoint: `fn.concat("https://", ${base}Site.properties.defaultHostName as any)`,
      agentIdentityClientId: `${base}Identity.properties.clientId as any`,
      agentIdentityPrincipalId: `${base}Identity.properties.principalId as any`,
      agentIdentityResourceId: `${base}Identity.id`,
      backendBaseUrl: `fn.concat("https://", ${base}Site.properties.defaultHostName as any)`,
      backendAudience:
        microsoftEntraAuthentication(resource)
          ? `${base}Audience`
          : `${base}Identity.properties.clientId as any`,
      backendIdentityClientId: `${base}Identity.properties.clientId as any`,
      backendIdentityPrincipalId: `${base}Identity.properties.principalId as any`,
      backendIdentityResourceId: `${base}Identity.id`,
      frontendBaseUrl: `fn.concat("https://", ${base}Site.properties.defaultHostName as any)`,
      frontendIdentityClientId: `${base}Identity.properties.clientId as any`,
      frontendIdentityPrincipalId: `${base}Identity.properties.principalId as any`,
      frontendIdentityResourceId: `${base}Identity.id`,
    };
  }

  #prepareWorkflowPlans(): void {
    for (const resource of this.#ofKind("workflow-host")) {
      const template = requiredObject(
        this.#options.templates[resource.id],
        `Workflow template '${resource.id}'`,
      );
      const templateResource = requiredObject(
        requiredArray(template.resources, `${resource.id}.resources`)[0],
        `${resource.id}.resources[0]`,
      );
      const definition = requiredObject(
        requiredObject(templateResource.properties, `${resource.id}.properties`).definition,
        `${resource.id}.definition`,
      );
      const templateParameters = asObject(template.parameters);
      const configuredParameters = asObject(asObject(resource.parameters).parameters);
      const expressions = new Map<string, string>();
      const declarations: string[] = [];
      const bindings: string[] = [];
      const deploymentCondition = this.#workflowDeploymentCondition(resource);
      if (deploymentCondition) {
        this.#parameters.push(
          `const ${deploymentCondition} = stack.parameters.add(${JSON.stringify(deploymentCondition)}, "bool");`,
        );
        this.#parameterBindings.push(
          `${deploymentCondition}: fn.eq(\n      fn.readEnvironmentVariable(${JSON.stringify(workflowDeploymentEnvironment(resource.id))}, "false"),\n      "true",\n    )`,
        );
      }
      for (const name of collectWorkflowInputs(definition)) {
        const configured = asObject(configuredParameters[name]).value;
        if (configured === undefined) {
          throw new Error(`Workflow '${resource.id}' parameter '${name}' is not configured.`);
        }
        if (hasOutputBinding(configured)) {
          expressions.set(name, this.#renderValue(configured));
          continue;
        }
        const variable = `${identifier(resource.id)}${pascalCase(name)}`;
        const parameterType = String(asObject(templateParameters[name]).type ?? "string").toLowerCase();
        if (parameterType === "array") {
          declarations.push(
            `const ${variable} = stack.parameters.add(${JSON.stringify(variable)}, "string");`,
          );
          expressions.set(name, `fn.split(${variable}, ",")`);
          bindings.push(
            `${variable}: fn.readEnvironmentVariable(${JSON.stringify(workflowEnvironment(resource.id, name))}, ${JSON.stringify(arrayValue(configured).join(","))})`,
          );
        } else {
          declarations.push(
            `const ${variable} = stack.parameters.add(${JSON.stringify(variable)}, "string");`,
          );
          expressions.set(name, variable);
          bindings.push(
            `${variable}: fn.readEnvironmentVariable(${JSON.stringify(workflowEnvironment(resource.id, name))}, ${JSON.stringify(String(configured))})`,
          );
        }
      }
      this.#workflowPlans.push({
        resource,
        definition,
        templateParameters,
        functionName: `create${pascalCase(resource.id)}Definition`,
        importPath:
          this.#owner === undefined
            ? `../${resource.requiredBy[0] ?? "workflow"}/workflow.js`
            : "./workflow.js",
          ...(deploymentCondition ? { deploymentCondition } : {}),
        parameterExpressions: expressions,
        parameterDeclarations: declarations,
        parameterBindings: bindings,
      });
      this.#parameters.push(...declarations);
    }
  }

  #renderValue(value: unknown): string {
    if (typeof value === "string") {
      const exact = /^\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value);
      if (exact) {
        const output =
          this.#outputs.get(exact[1]!) ?? this.#externalOutput(exact[1]!);
        return output;
      }
      const parts: string[] = [];
      let offset = 0;
      for (const match of value.matchAll(/\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g)) {
        if (match.index! > offset) {
          parts.push(JSON.stringify(value.slice(offset, match.index)));
        }
        const output =
          this.#outputs.get(match[1]!) ?? this.#externalOutput(match[1]!);
        parts.push(output);
        offset = match.index! + match[0].length;
      }
      if (parts.length === 0) return JSON.stringify(value);
      if (offset < value.length) parts.push(JSON.stringify(value.slice(offset)));
      return `fn.concat(${parts.join(", ")})`;
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.#renderValue(item)).join(", ")}]`;
    }
    if (typeof value === "object" && value !== null) {
      return `{ ${Object.entries(value)
        .map(([key, item]) => `${JSON.stringify(key)}: ${this.#renderValue(item)}`)
        .join(", ")} }`;
    }
    return JSON.stringify(value);
  }

  #scopeExpression(resource: ResourceRequirement): string {
    if (resource.kind === "container-registry") return "deploymentRegistry";
    if (!this.#owns(resource)) this.#ensureExistingResource(resource);
    const base = identifier(resource.id);
    const scopes: Readonly<Record<string, string>> = {
      "ai-project": `${base}Project`,
      "document-database": `${base}Account`,
      "object-storage": `${base}Account`,
      "configuration-store": `${base}Store`,
      "application-monitoring": `${base}Insights`,
      "container-host": `${base}Site`,
      "bot-identity": `${base}Identity`,
    };
    const scope = scopes[resource.kind];
    if (!scope) throw new Error(`Resource '${resource.id}' cannot own access grants.`);
    return scope;
  }

  #ensureExistingResource(resource: ResourceRequirement): void {
    if (this.#owns(resource) || this.#existingResources.has(resource.id)) return;
    this.#existingResources.add(resource.id);
    const base = identifier(resource.id);
    switch (resource.kind) {
      case "ai-project": {
        const accountName = this.#input("AI_RESOURCE_NAME");
        const projectName = this.#input("AI_PROJECT_NAME");
        this.#sections.push(`const ${base}Account = new Account(stack, {
  name: ${accountName},
  existing: true,
});

const ${base}Project = new Project(${base}Account, {
  name: ${projectName},
  existing: true,
});
`);
        return;
      }
      case "configuration-store": {
        const name = this.#input(implementationOutput(resource.id, "NAME"));
        this.#sections.push(`const ${base}Store = new ConfigurationStore(stack, {
  name: ${name},
  existing: true,
});
`);
        return;
      }
      case "document-database": {
        const name = this.#input(implementationOutput(resource.id, "NAME"));
        this.#sections.push(`const ${base}Account = new DatabaseAccount(stack, {
  name: ${name},
  existing: true,
});
`);
        return;
      }
      case "object-storage": {
        const name = this.#input(implementationOutput(resource.id, "NAME"));
        this.#sections.push(`const ${base}Account = new StorageAccount(stack, {
  name: ${name},
  existing: true,
});
`);
        return;
      }
      case "application-monitoring": {
        const name = this.#input(implementationOutput(resource.id, "NAME"));
        this.#sections.push(`const ${base}Insights = new ApplicationInsightsComponent(stack, {
  name: ${name},
  existing: true,
});
`);
        return;
      }
      default:
        throw new Error(
          `Resource '${resource.id}' of kind '${resource.kind}' cannot be referenced from '${this.#owner}'.`,
        );
    }
  }

  #principalKey(resource: ResourceRequirement): string {
    const base = identifier(resource.id);
    if (resource.kind === "container-host") return `${base}Identity.id`;
    if (resource.kind === "bot-identity") return `${base}Identity.id`;
    throw new Error(`Resource '${resource.id}' cannot produce a principal.`);
  }

  #isHosted(resource: ResourceRequirement): boolean {
    return (
      resource.kind === "container-host" &&
      resource.requiredBy.some(
        (component) => this.#componentKinds.get(component) === "hosted-agent",
      )
    );
  }

  #hasHostedAgent(): boolean {
    return this.#resources.some((resource) => this.#isHosted(resource));
  }

  #hasRegistry(): boolean {
    return this.#resources.some((resource) => resource.kind === "container-host");
  }

  #hasExplicitRegistryAccess(principal: ResourceRequirement): boolean {
    const principalOutputs = new Set(principal.produces ?? []);
    return this.#resources.some(
      (resource) =>
        resource.kind === "container-registry" &&
        accessValues(resource).some(
          (grant) =>
            grant.role === "AcrPull" && principalOutputs.has(grant.principalOutput),
        ),
    );
  }

  #ofKind(kind: string): ResourceRequirement[] {
    return this.#resources.filter(
      (resource) => resource.kind === kind && this.#owns(resource),
    );
  }

  #owns(resource: ResourceRequirement): boolean {
    return this.#owner === undefined || resourceOwner(resource) === this.#owner;
  }

  #input(
    environmentName: string,
    hint = environmentName,
    fallback?: string,
  ): string {
    const existing = this.#inputParameters.get(environmentName);
    if (existing) return existing;
    const variable = `input${pascalCase(hint)}`;
    this.#inputParameters.set(environmentName, variable);
    this.#parameters.push(
      `const ${variable} = stack.parameters.add(${JSON.stringify(variable)}, "string");`,
    );
    this.#parameterBindings.push(
      `${variable}: fn.readEnvironmentVariable(${JSON.stringify(environmentName)}${fallback === undefined ? "" : `, ${JSON.stringify(fallback)}`})`,
    );
    return variable;
  }

  #externalOutput(name: string): string {
    const existing = this.#externalOutputs.get(name);
    if (existing) return existing;
    const producer = this.#resources.find((resource) =>
      resource.produces?.includes(name),
    );
    if (!producer) throw new Error(`Output '${name}' is unavailable.`);
    const expression = this.#input(name, name);
    this.#externalOutputs.set(name, expression);
    return expression;
  }

  #solutionName(): string {
    return this.#options.requirements.solution.name;
  }

  #workflowDeploymentCondition(
    workflow: ResourceRequirement,
  ): string | undefined {
    const owner = resourceOwner(workflow);
    const hasInteractiveConnection = this.#resources.some(
      (resource) =>
        resource.kind === "authorized-api-connection" &&
        resource.authorization === "interactive" &&
        resourceOwner(resource) === owner,
    );
    return hasInteractiveConnection
      ? `deploy${pascalCase(workflow.id)}`
      : undefined;
  }

  #effectiveOwner(): string {
    return this.#owner ?? "all";
  }

  #configurationValueOwner(value: unknown): string | undefined {
    const bindings = outputBindings(value);
    if (bindings.some((binding) => binding === "agentVersion") && this.#hasHostedAgent()) {
      return undefined;
    }
    if (this.#owner === undefined) return "all";
    if (bindings.length === 0) return "shared";
    const owners = bindings.map((binding) => {
      const producer = this.#resources.find((resource) =>
        resource.produces?.includes(binding),
      );
      if (!producer) throw new Error(`Output '${binding}' is unavailable.`);
      if (this.#isHosted(producer)) return undefined;
      return resourceOwner(producer);
    });
    if (owners.some((owner) => owner === undefined)) return undefined;
    const resolvedOwners = owners.filter(
      (owner): owner is string => owner !== undefined,
    );
    const order = ["shared", ...this.#options.orderedComponents];
    return resolvedOwners.reduce((latest, owner) =>
      order.indexOf(owner!) > order.indexOf(latest) ? owner! : latest,
    "shared");
  }
}

function renderWorkflowValue(value: unknown, depth: number): string {
  if (typeof value === "string") {
    const parameter = /^\[parameters\('([^']+)'\)\]$/.exec(value);
    if (parameter) return `inputs.${typescriptProperty(parameter[1]!)}`;
    const concat = /^\[concat\(parameters\('([^']+)'\), '((?:[^']|'')*)'\)\]$/.exec(value);
    if (concat) {
      return `fn.concat(inputs.${typescriptProperty(concat[1]!)}, ${JSON.stringify(concat[2]!.replaceAll("''", "'"))})`;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return `[\n${value
      .map((item) => `${childIndent}${renderWorkflowValue(item, depth + 1)},`)
      .join("\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return `{\n${entries
      .map(
        ([key, item]) =>
          `${childIndent}${JSON.stringify(key)}: ${renderWorkflowValue(item, depth + 1)},`,
      )
      .join("\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function collectWorkflowInputs(value: unknown): string[] {
  const names = new Set<string>();
  const source = JSON.stringify(value);
  for (const match of source.matchAll(/parameters\\?\('([^']+)'\\?\)/g)) {
    if (match[1] && match[1] !== "$connections") names.add(match[1]);
  }
  return [...names];
}

function workflowInputType(type: unknown): string {
  switch (String(type ?? "string").toLowerCase()) {
    case "array":
      return "ExpressionOrValue<string[]>";
    case "bool":
    case "boolean":
      return "ExpressionOrValue<boolean>";
    case "int":
    case "integer":
      return "ExpressionOrValue<number>";
    case "object":
      return "Readonly<Record<string, unknown>>";
    default:
      return "ExpressionOrValue<string>";
  }
}

function accessValues(resource: ResourceRequirement): Array<{
  principalOutput: string;
  role: string;
}> {
  return arrayValue(resource.access).map((value, index) => {
    const access = requiredObject(value, `${resource.id}.access[${index}]`);
    return {
      principalOutput: requiredString(
        access.principalOutput,
        `${resource.id}.access[${index}].principalOutput`,
      ),
      role: requiredString(access.role, `${resource.id}.access[${index}].role`),
    };
  });
}

function resourceOwner(resource: ResourceRequirement): string {
  return resource.requiredBy.length === 1
    ? resource.requiredBy[0]!
    : "shared";
}

function ownerNeedsProvisioning(
  options: ProvisioningSourceOptions,
  owner: string,
): boolean {
  if (owner === "shared" && options.requirements.resources.length > 0) return true;
  const componentKinds = new Map(
    options.solution.components.map((component) => [component.id, component.kind]),
  );
  const ownsInfrastructure = options.requirements.resources.some((resource) => {
    if (resourceOwner(resource) !== owner) return false;
    if (resource.kind === "teams-application") return false;
    if (
      resource.kind === "container-host" &&
      resource.requiredBy.some(
        (component) => componentKinds.get(component) === "hosted-agent",
      )
    ) {
      return false;
    }
    return true;
  });
  if (ownsInfrastructure) return true;
  return options.requirements.resources
    .filter((resource) => resource.kind === "configuration-store")
    .some((resource) =>
      Object.values(asObject(asObject(resource.configuration).values)).some(
        (value) => configurationValueOwner(options, value) === owner,
      ),
    );
}

function configurationValueOwner(
  options: ProvisioningSourceOptions,
  value: unknown,
): string | undefined {
  const bindings = outputBindings(value);
  const componentKinds = new Map(
    options.solution.components.map((component) => [component.id, component.kind]),
  );
  if (bindings.length === 0) return "shared";
  const owners = bindings.map((binding) => {
    const producer = options.requirements.resources.find((resource) =>
      resource.produces?.includes(binding),
    );
    if (!producer) throw new Error(`Output '${binding}' is unavailable.`);
    if (
      producer.kind === "container-host" &&
      producer.requiredBy.some(
        (component) => componentKinds.get(component) === "hosted-agent",
      )
    ) {
      return undefined;
    }
    if (binding === "agentVersion" && componentKinds.has("agent")) {
      return undefined;
    }
    return resourceOwner(producer);
  });
  if (owners.some((owner) => owner === undefined)) return undefined;
  const resolvedOwners = owners.filter(
    (owner): owner is string => owner !== undefined,
  );
  const order = ["shared", ...options.orderedComponents];
  return resolvedOwners.reduce(
    (latest, owner) =>
      order.indexOf(owner!) > order.indexOf(latest) ? owner! : latest,
    "shared",
  );
}

function outputBindings(value: unknown): string[] {
  const names = new Set<string>();
  const source = JSON.stringify(value);
  for (const match of source.matchAll(/\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function containsOutput(value: unknown, output: string): boolean {
  return JSON.stringify(value).includes("${output." + output + "}");
}

function hasOutputBinding(value: unknown): boolean {
  return /\$\{output\.[A-Za-z][A-Za-z0-9_]*\}/.test(JSON.stringify(value));
}

function implementationOutput(resourceId: string, suffix: string): string {
  return `DEPLOY_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

function modelDeploymentName(resource: ResourceRequirement): string {
  const configuration = asObject(resource.configuration);
  return stringValue(
    configuration.deploymentName,
    stringValue(configuration.model, resource.id),
  );
}

function defaultModelVersion(): string {
  return "2025-04-14";
}

function createResourceEnvironment(resourceId: string): string {
  return `DEPLOY_CREATE_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function workflowEnvironment(resourceId: string, parameter: string): string {
  return `DEPLOY_WORKFLOW_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${parameter.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function workflowDeploymentEnvironment(resourceId: string): string {
  return `DEPLOY_WORKFLOW_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function identifier(value: string): string {
  const parts = value.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const joined = parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  return /^[A-Za-z_$]/.test(joined) ? joined : `resource${joined}`;
}

function pascalCase(value: string): string {
  const name = identifier(value);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function typescriptProperty(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function normalizedName(solution: string, resource: string): string {
  return `${solution}-${resource}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

export function entraApplicationUniqueNamePrefix(
  solution: string,
  resource: string,
): string {
  return hyphenatedPrefix(solution, `${resource}-api`, 82);
}

function hyphenatedPrefix(
  solution: string,
  resource: string,
  maximumPrefixLength: number,
): string {
  const prefix = normalizedName(solution, resource)
    .slice(0, maximumPrefixLength)
    .replace(/-+$/g, "");
  return `${prefix}-`;
}

function hyphenatedQualifiedPrefix(
  solution: string,
  resource: string,
  qualifier: string,
  maximumPrefixLength: number,
): string {
  const suffix = `-${qualifier}`;
  const prefix = normalizedName(solution, resource)
    .slice(0, maximumPrefixLength - suffix.length)
    .replace(/-+$/g, "");
  return `${prefix}${suffix}-`;
}

function alphanumericPrefix(
  solution: string,
  resource: string,
  maximumPrefixLength: number,
): string {
  return `${solution}${resource}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, maximumPrefixLength);
}

function relativePath(from: string, to: string): string {
  const value = pathRelative(from, to).replaceAll("\\", "/");
  return value.startsWith(".") ? value : `./${value}`;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

interface EntraApplicationPlan {
  resource: ResourceRequirement;
  base: string;
  uniqueNamePrefix: string;
  displayName: string;
  delegatedPermissionScope: string;
  authorizedClientApplicationIds: readonly string[];
  callerPrincipalOutputs: readonly string[];
}

export function hasEntraApplications(
  options: ProvisioningSourceOptions,
): boolean {
  return entraApplicationPlans(options).length > 0;
}

export function entraConfigurationOwner(
  options: ProvisioningSourceOptions,
): string | undefined {
  const plans = entraApplicationPlans(options);
  if (plans.length === 0) return undefined;
  const outputProducers = new Map<string, ResourceRequirement>();
  for (const resource of options.requirements.resources) {
    for (const output of resource.produces ?? []) {
      outputProducers.set(output, resource);
    }
  }
  const owners = new Set<string>();
  for (const plan of plans) {
    owners.add(resourceOwner(plan.resource));
    for (const output of plan.callerPrincipalOutputs) {
      const producer = outputProducers.get(output);
      for (const owner of producer?.requiredBy ?? []) owners.add(owner);
    }
  }
  const order = ["shared", ...options.orderedComponents];
  return [...owners].reduce((latest, owner) =>
    order.indexOf(owner) > order.indexOf(latest) ? owner : latest
  , "shared");
}

function entraApplicationPlans(
  options: ProvisioningSourceOptions,
): EntraApplicationPlan[] {
  return options.requirements.resources.flatMap((resource) => {
    const authentication = microsoftEntraAuthentication(resource);
    if (!authentication) return [];
    return [{
      resource,
      base: identifier(resource.id),
      uniqueNamePrefix: entraApplicationUniqueNamePrefix(
        options.requirements.solution.name,
        resource.id,
      ),
      displayName: `${options.requirements.solution.name} ${resource.id} API`,
      delegatedPermissionScope:
        authentication.delegatedPermissionScope ?? "access_as_user",
      authorizedClientApplicationIds:
        authentication.authorizedClientApplicationIds,
      callerPrincipalOutputs: entraCallerPrincipalOutputs(options, resource),
    }];
  });
}

function entraCallerPrincipalOutputs(
  options: ProvisioningSourceOptions,
  target: ResourceRequirement,
): string[] {
  const resources = options.requirements.resources;
  const principals = new Set<string>();
  const targetOutputs = new Set(target.produces ?? []);
  const ingress = asObject(asObject(target.configuration).ingress);
  const allowedSources = arrayValue(ingress.allowedSourceResources)
    .filter((value): value is string => typeof value === "string");
  for (const sourceId of allowedSources) {
    const source = resources.find((resource) => resource.id === sourceId);
    if (!source) continue;
    const configuredIdentity = exactOutputBinding(
      asObject(source.configuration).identityResourceId,
    );
    const identityOutput = configuredIdentity ??
      source.produces?.find((output) => /IdentityResourceId$/.test(output));
    const principal = identityOutput
      ? principalOutputForIdentity(resources, identityOutput)
      : source.produces?.find((output) => /IdentityPrincipalId$/.test(output));
    if (principal) principals.add(principal);
  }
  for (const workflow of resources.filter(
    (resource) => resource.kind === "workflow-host",
  )) {
    const bindings = outputBindings(workflow.parameters);
    if (!bindings.some((binding) => targetOutputs.has(binding))) continue;
    for (const identityOutput of bindings.filter((binding) =>
      /IdentityResourceId$/.test(binding)
    )) {
      const principal = principalOutputForIdentity(resources, identityOutput);
      if (principal) principals.add(principal);
    }
  }
  return [...principals];
}

function principalOutputForIdentity(
  resources: readonly ResourceRequirement[],
  identityOutput: string,
): string | undefined {
  const producer = resources.find((resource) =>
    resource.produces?.includes(identityOutput)
  );
  if (!producer) return undefined;
  const expected = identityOutput.replace(/ResourceId$/, "PrincipalId");
  return producer.produces?.includes(expected)
    ? expected
    : producer.produces?.find((output) => /IdentityPrincipalId$/.test(output));
}

function exactOutputBinding(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
}

function entraOutput(resourceId: string, suffix: string): string {
  return `DEPLOY_ENTRA_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

function microsoftEntraAuthentication(
  resource: ResourceRequirement,
):
  | {
      delegatedPermissionScope?: string;
      authorizedClientApplicationIds: readonly string[];
    }
  | undefined {
  if (
    resource.authentication !== "managed-identity" &&
    resource.authentication !== "microsoft-entra"
  ) {
    return undefined;
  }
  const authentication = asObject(
    asObject(resource.configuration).authentication,
  );
  if (
    resource.authentication === "managed-identity" &&
    Object.keys(authentication).length === 0
  ) {
    return { authorizedClientApplicationIds: [] };
  }
  const provider = requiredString(
    authentication.provider,
    `${resource.id}.configuration.authentication.provider`,
  );
  if (provider !== "microsoft-entra") {
    throw new Error(
      `${resource.id}.configuration.authentication.provider must be 'microsoft-entra'.`,
    );
  }
  return {
    delegatedPermissionScope: requiredString(
      authentication.delegatedPermissionScope,
      `${resource.id}.configuration.authentication.delegatedPermissionScope`,
    ),
    authorizedClientApplicationIds: requiredArray(
      authentication.authorizedClientApplicationIds,
      `${resource.id}.configuration.authentication.authorizedClientApplicationIds`,
    ).map((applicationId, index) =>
      requiredString(
        applicationId,
        `${resource.id}.configuration.authentication.authorizedClientApplicationIds[${index}]`,
      )
    ),
  };
}

function requiredObject(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
