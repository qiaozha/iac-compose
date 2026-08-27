import { implementationOutput } from "../outputs.js";
import type { ProvisioningSourceOptions } from "../types.js";
import { entraApplicationPlans, entraOutput } from "./planning.js";

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
    siteNameOutput: ${JSON.stringify(implementationOutput(plan.resource.id, "NAME"))},
    authorizedClientApplicationIds: ${JSON.stringify(plan.authorizedClientApplicationIds)},
    callerApplications: ${JSON.stringify(plan.callerApplications)},
    callerPrincipalOutputs: ${JSON.stringify(plan.callerPrincipalOutputs)},
  },`).join("\n");
  return `import {
  captureAzure,
  captureAzureJson,
  ensureAppServiceClientAuthorization,
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
    layer: "identity",
    dependsOn: ["shared"],
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
  await persistEnvironment(deployment, outputs);
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
    for (const caller of plan.callerApplications) {
      const principalId = deployment.dryRun
        ? caller.applicationId
        : (
            await captureAzure(deployment, [
              "ad",
              "sp",
              "show",
              "--id",
              caller.applicationId,
              "--query",
              "id",
              "--output",
              "tsv",
            ])
          ).trim();
      if (!principalId) {
        throw new Error(
          "Application '" + caller.applicationId + "' has no service principal.",
        );
      }
      environmentValues[caller.principalOutput] = principalId;
    }
  }
  const provisionPermissions = (
    name: string,
    preAuthorizeClients: boolean,
  ) => deployment.provision(name, {
    entrypoint: identityConfigurationEntrypoint,
    outputDirectory: generatedIdentityProject,
    layer: "identity",
    dependsOn: ["shared"],
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
    await persistEnvironment(deployment, outputs);
  }
  await deployment.deploy("server application client authorization", async () => {
    for (const plan of applicationPlans) {
      const allowedApplicationIds = [
        ...plan.authorizedClientApplicationIds,
        ...plan.callerApplications.map(({ applicationId }) => applicationId),
      ];
      for (const output of plan.callerPrincipalOutputs) {
        const principalId =
          environmentValues[output]?.trim() || process.env[output]?.trim();
        if (!principalId) continue;
        const applicationId = (
          await captureAzure(deployment, [
            "ad",
            "sp",
            "show",
            "--id",
            principalId,
            "--query",
            "appId",
            "--output",
            "tsv",
          ])
        ).trim();
        if (!applicationId) {
          throw new Error(
            "Service principal '" + principalId + "' did not return an application ID.",
          );
        }
        allowedApplicationIds.push(applicationId);
      }
      await ensureAppServiceClientAuthorization(deployment, {
        resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
        siteName: requiredEnv(plan.siteNameOutput),
        subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
        allowedApplicationIds,
      });
    }
  });
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