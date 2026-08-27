import {
  captureAzure,
  captureAzureJson,
  runAzure,
  type Deployment,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  generatedIdentityProject,
  identityBootstrapEntrypoint,
  identityConfigurationEntrypoint,
} from "../../runtime/paths.js";

const identityDeploymentName = "chatbot-identity";

interface ApplicationSummary {
  appId: string;
  uniqueName?: string;
}

interface ApplicationDefinition extends ApplicationSummary {
  appRoles?: Array<{
    allowedMemberTypes?: string[];
    description?: string;
    displayName?: string;
    id: string;
    isEnabled?: boolean;
    value?: string;
  }>;
  api?: {
    oauth2PermissionScopes?: Array<{
      adminConsentDescription?: string;
      adminConsentDisplayName?: string;
      id: string;
      isEnabled?: boolean;
      type?: string;
      userConsentDescription?: string;
      userConsentDisplayName?: string;
      value?: string;
    }>;
  };
}

export async function ensureServerApplication(deployment: Deployment): Promise<string> {
  const environment = requiredEnv("AZURE_ENV_NAME");
  const displayName = `azuresdkqabot-server-${environment}`;
  const applicationUniqueName = deployment.dryRun
    ? displayName
    : await resolveApplicationUniqueName(deployment, environment);
  const outputs = await deployment.provision("server application registration", {
    entrypoint: identityBootstrapEntrypoint,
    outputDirectory: generatedIdentityProject,
    deploymentName: identityDeploymentName,
    location: requiredEnv("AZURE_LOCATION"),
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    environmentValues: {
      SERVER_APPLICATION_UNIQUE_NAME: applicationUniqueName,
      SERVICE_MANAGEMENT_REFERENCE:
        process.env.SERVICE_MANAGEMENT_REFERENCE?.trim() ?? "",
    },
  });
  if (deployment.dryRun) {
    const appId = process.env.SERVER_AUDIENCE ?? "00000000-0000-0000-0000-000000000004";
    Object.assign(process.env, {
      SERVER_AUDIENCE: appId,
      RAG_SERVICE_SCOPE: `api://${appId}/.default`,
      SERVER_APPLICATION_UNIQUE_NAME: applicationUniqueName,
      SERVER_APPLICATION_OBJECT_ID:
        "00000000-0000-0000-0000-000000000008",
      SERVER_SERVICE_PRINCIPAL_ID:
        "00000000-0000-0000-0000-000000000009",
    });
    return appId;
  }
  const appId = requiredOutput(outputs, "SERVER_AUDIENCE");
  await persistEnvironment(deployment, {
    SERVER_AUDIENCE: appId,
    RAG_SERVICE_SCOPE: requiredOutput(outputs, "RAG_SERVICE_SCOPE"),
    SERVER_APPLICATION_UNIQUE_NAME: requiredOutput(
      outputs,
      "SERVER_APPLICATION_UNIQUE_NAME",
    ),
    SERVER_APPLICATION_OBJECT_ID: requiredOutput(
      outputs,
      "SERVER_APPLICATION_OBJECT_ID",
    ),
    SERVER_SERVICE_PRINCIPAL_ID: requiredOutput(
      outputs,
      "SERVER_SERVICE_PRINCIPAL_ID",
    ),
  });
  return appId;
}

export async function configureServerApplication(deployment: Deployment): Promise<void> {
  const provisionPermissions = (
    name: string,
    preAuthorizeClients: boolean,
    environmentValues: Record<string, string>,
  ) =>
    deployment.provision(name, {
      entrypoint: identityConfigurationEntrypoint,
      outputDirectory: generatedIdentityProject,
      deploymentName: identityDeploymentName,
      location: requiredEnv("AZURE_LOCATION"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      environmentValues: {
        ...environmentValues,
        SERVICE_MANAGEMENT_REFERENCE:
          process.env.SERVICE_MANAGEMENT_REFERENCE?.trim() ?? "",
        SERVER_PREAUTHORIZE_CLIENTS: preAuthorizeClients ? "true" : "false",
      },
    });

  if (deployment.dryRun) {
    const environmentValues = {
      BOT_IDENTITY_PRINCIPAL_ID:
        process.env.BOT_IDENTITY_PRINCIPAL_ID ?? "",
      SERVER_DELEGATED_SCOPE_ID:
        process.env.SERVER_DELEGATED_SCOPE_ID ?? "",
      SERVER_APPLICATION_ROLE_ID:
        process.env.SERVER_APPLICATION_ROLE_ID ?? "",
      SERVER_EXISTING_PERMISSION_SCOPES: "[]",
      SERVER_EXISTING_APPLICATION_ROLES: "[]",
    };
    await provisionPermissions(
      "server application permissions",
      false,
      environmentValues,
    );
    await provisionPermissions(
      "server application pre-authorization",
      true,
      environmentValues,
    );
    return;
  }
  const application = await captureAzureJson<ApplicationDefinition>(deployment, [
    "ad",
    "app",
    "show",
    "--id",
    requiredEnv("SERVER_AUDIENCE"),
  ]);
  const delegatedScope = application.api?.oauth2PermissionScopes?.find(
    (scope) => scope.value === "access_as_user",
  );
  const applicationRole = application.appRoles?.find(
    (role) => role.value === "access_as_application",
  );
  const existingPermissionScopes = (
    application.api?.oauth2PermissionScopes ?? []
  )
    .filter((scope) => scope.value !== "access_as_user")
    .map(normalizePermissionScope);
  const existingApplicationRoles = (application.appRoles ?? [])
    .filter((role) => role.value !== "access_as_application")
    .map(normalizeApplicationRole);
  let botIdentityPrincipalId = "";
  const botIdentityName = process.env.BOT_IDENTITY_NAME?.trim();
  if (botIdentityName) {
    botIdentityPrincipalId = (
      await captureAzure(deployment, [
        "identity",
        "show",
        "--name",
        botIdentityName,
        "--resource-group",
        requiredEnv("AZURE_RESOURCE_GROUP"),
        "--query",
        "principalId",
        "--output",
        "tsv",
      ])
    ).trim();
  }
  const environmentValues = {
    BOT_IDENTITY_PRINCIPAL_ID: botIdentityPrincipalId,
    SERVER_DELEGATED_SCOPE_ID: delegatedScope?.id ?? "",
    SERVER_APPLICATION_ROLE_ID: applicationRole?.id ?? "",
    SERVER_EXISTING_PERMISSION_SCOPES: JSON.stringify(
      existingPermissionScopes,
    ),
    SERVER_EXISTING_APPLICATION_ROLES: JSON.stringify(
      existingApplicationRoles,
    ),
  };
  await provisionPermissions(
    "server application permissions",
    false,
    environmentValues,
  );
  const outputs = await provisionPermissions(
    "server application pre-authorization",
    true,
    environmentValues,
  );
  await persistEnvironment(deployment, {
    SERVER_AUDIENCE: requiredOutput(outputs, "SERVER_AUDIENCE"),
    RAG_SERVICE_SCOPE: requiredOutput(outputs, "RAG_SERVICE_SCOPE"),
    SERVER_APPLICATION_UNIQUE_NAME: requiredOutput(
      outputs,
      "SERVER_APPLICATION_UNIQUE_NAME",
    ),
    SERVER_APPLICATION_OBJECT_ID: requiredOutput(
      outputs,
      "SERVER_APPLICATION_OBJECT_ID",
    ),
    SERVER_SERVICE_PRINCIPAL_ID: requiredOutput(
      outputs,
      "SERVER_SERVICE_PRINCIPAL_ID",
    ),
    SERVER_APPLICATION_ROLE_ID: requiredOutput(
      outputs,
      "SERVER_APPLICATION_ROLE_ID",
    ),
    SERVER_DELEGATED_SCOPE_ID: requiredOutput(
      outputs,
      "SERVER_DELEGATED_SCOPE_ID",
    ),
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function resolveApplicationUniqueName(
  deployment: Deployment,
  environment: string,
): Promise<string> {
  const displayName = `azuresdkqabot-server-${environment}`;
  const persistedAppId = process.env.SERVER_AUDIENCE?.trim();
  let application =
    persistedAppId && isUuid(persistedAppId)
      ? await captureAzureJson<ApplicationSummary>(deployment, [
          "ad",
          "app",
          "show",
          "--id",
          persistedAppId,
        ]).catch(() => undefined)
      : undefined;
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
  if (!application) return displayName;

  const uniqueName = application.uniqueName?.trim();
  if (uniqueName) return uniqueName;

  await runAzure(deployment, [
    "ad",
    "app",
    "update",
    "--id",
    application.appId,
    "--set",
    `uniqueName=${displayName}`,
    "--output",
    "none",
  ]);
  return displayName;
}

function normalizePermissionScope(
  scope: NonNullable<
    NonNullable<ApplicationDefinition["api"]>["oauth2PermissionScopes"]
  >[number],
): Record<string, unknown> {
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

function normalizeApplicationRole(
  role: NonNullable<ApplicationDefinition["appRoles"]>[number],
): Record<string, unknown> {
  return {
    id: role.id,
    value: role.value ?? "",
    displayName: role.displayName ?? "",
    description: role.description ?? "",
    isEnabled: role.isEnabled ?? true,
    allowedMemberTypes: role.allowedMemberTypes ?? [],
  };
}

function requiredOutput(
  outputs: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = outputs[name]?.trim();
  if (!value) throw new Error(`Identity provisioning did not output '${name}'.`);
  return value;
}