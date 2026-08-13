import {
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

const identityDeploymentName = "contoso-support-identity";
const applicationPlans = [
  {
    resourceId: "backendCompute",
    displayName: "contoso-support backendCompute API",
    uniqueNamePrefix: "contoso-support-backendcompute-api-",
    delegatedPermissionScope: "token",
    applicationAppIdOutput: "DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_APP_ID",
    applicationObjectIdOutput: "DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_OBJECT_ID",
    servicePrincipalIdOutput: "DEPLOY_ENTRA_BACKENDCOMPUTE_SERVICE_PRINCIPAL_ID",
    applicationUniqueNameOutput: "DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_UNIQUE_NAME",
    delegatedScopeIdOutput: "DEPLOY_ENTRA_BACKENDCOMPUTE_DELEGATED_SCOPE_ID",
    applicationRoleIdOutput: "DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_ROLE_ID",
    preAuthorizeClientsOutput: "DEPLOY_ENTRA_BACKENDCOMPUTE_PREAUTHORIZE_CLIENTS",
    existingPermissionScopesOutput: "DEPLOY_ENTRA_BACKENDCOMPUTE_EXISTING_PERMISSION_SCOPES",
    existingApplicationRolesOutput: "DEPLOY_ENTRA_BACKENDCOMPUTE_EXISTING_APPLICATION_ROLES",
    callerPrincipalOutputs: ["botIdentityPrincipalId","backendIdentityPrincipalId"],
  },
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
        `uniqueName eq '${escaped}'`,
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
    `uniqueName=${desiredUniqueName}`,
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
