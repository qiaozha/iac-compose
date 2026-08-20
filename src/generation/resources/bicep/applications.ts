import type { ResourceContractRequirement } from "../../../shared/contracts/resources/types.js";
import type { BicepRenderContext } from "./context.js";
import {
  applicationAudience,
  asObject,
  azureName,
  bicepString,
  resourceOutputName,
} from "./syntax.js";

export function renderContainerHost(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  if (context.isHostedAgent(resource)) return;
  const symbols = context.symbols.get(resource.id)!;
  const siteName = azureName(
    context.contract.solution.name,
    resource.id,
    60,
    true,
  );
  const runtimeSettings = asObject(asObject(resource.configuration).runtimeSettings);
  const audience = applicationAudience(
    context.contract.solution.name,
    resource.id,
  );
  const appSettings = [
    { name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE", value: "false" },
    { name: "WEBSITES_PORT", value: String(resource.containerPort ?? 8080) },
    ...Object.entries(runtimeSettings).map(([name, value]) => ({ name, value })),
  ];
  const attachedIdentities = [`'\${${symbols.identity}.id}': {}`];
  if (
    resource.authentication === "bot-framework" &&
    context.outputs.has("botIdentityResourceId")
  ) {
    attachedIdentities.push(
      `'\${${context.outputs.get("botIdentityResourceId")!}}': {}`,
    );
  }
  if (resource.authentication === "managed-identity") {
    context.sections.push(
      "",
      `resource ${symbols.application} 'Microsoft.Graph/applications@v1.0' = {`,
      `  uniqueName: ${azureName(context.contract.solution.name, `${resource.id}-api`, 90, true)}`,
      `  displayName: ${bicepString(`${context.contract.solution.name} ${resource.id} API`)}`,
      "  signInAudience: 'AzureADMyOrg'",
      `  identifierUris: [${audience}]`,
      "  api: { requestedAccessTokenVersion: 2 }",
      "}",
      "",
      `resource ${symbols.servicePrincipal} 'Microsoft.Graph/servicePrincipals@v1.0' = {`,
      `  appId: ${symbols.application}.appId`,
      "}",
    );
  }
  context.sections.push(
    "",
    `resource ${symbols.identity} 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {`,
    `  name: ${azureName(context.contract.solution.name, `${resource.id}-identity`, 128, true)}`,
    "  location: location",
    "}",
    "",
    `resource ${symbols.main}Plan 'Microsoft.Web/serverfarms@2023-12-01' = {`,
    `  name: ${azureName(context.contract.solution.name, `${resource.id}-plan`, 40, true)}`,
    "  location: location",
    "  kind: 'linux'",
    "  sku: { name: 'B1', tier: 'Basic', capacity: 1 }",
    "  properties: { reserved: true }",
    "}",
    "",
    `resource ${symbols.site} 'Microsoft.Web/sites@2023-12-01' = {`,
    `  name: ${siteName}`,
    "  location: location",
    "  kind: 'app,linux,container'",
    `  tags: { 'azd-service-name': ${bicepString(resource.requiredBy[0] ?? resource.id)} }`,
    "  identity: {",
    "    type: 'UserAssigned'",
    "    userAssignedIdentities: {",
    ...attachedIdentities.map((identity) => `      ${identity}`),
    "    }",
    "  }",
    "  properties: {",
    `    serverFarmId: ${symbols.main}Plan.id`,
    "    httpsOnly: true",
    "    siteConfig: {",
    "      linuxFxVersion: 'DOCKER|mcr.microsoft.com/azuredocs/aci-helloworld:latest'",
    "      alwaysOn: true",
    "      acrUseManagedIdentityCreds: true",
    `      acrUserManagedIdentityID: ${symbols.identity}.properties.clientId`,
    ...(resource.healthPath
      ? [`      healthCheckPath: ${bicepString(resource.healthPath)}`]
      : []),
    "      appSettings: [",
    ...appSettings.map(
      (setting) =>
        `        { name: ${bicepString(setting.name)}, value: ${context.renderValue(setting.value)} }`,
    ),
    "      ]",
    "    }",
    "  }",
    "}",
    ...(resource.authentication === "managed-identity"
      ? [
          "",
          `resource ${symbols.main}Auth 'Microsoft.Web/sites/config@2023-12-01' = {`,
          `  parent: ${symbols.site}`,
          "  name: 'authsettingsV2'",
          "  properties: {",
          "    platform: { enabled: true, runtimeVersion: '~1' }",
          "    globalValidation: {",
          "      requireAuthentication: true",
          "      unauthenticatedClientAction: 'Return401'",
          ...(resource.healthPath
            ? [`      excludedPaths: [${bicepString(resource.healthPath)}]`]
            : []),
          "    }",
          "    identityProviders: {",
          "      azureActiveDirectory: {",
          "        enabled: true",
          "        registration: {",
          `          clientId: ${symbols.application}.appId`,
          `          openIdIssuer: '\${environment().authentication.loginEndpoint}\${tenant().tenantId}/v2.0'`,
          "        }",
          "        validation: {",
          "          allowedAudiences: [",
          `            ${symbols.application}.appId`,
          `            ${audience}`,
          "          ]",
          "        }",
          "      }",
          "    }",
          "    login: { tokenStore: { enabled: true } }",
          "  }",
          "}",
        ]
      : []),
    "",
    `resource ${symbols.main}AcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {`,
    "  name: guid(deploymentRegistry.id, " +
      `${symbols.identity}.id, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d'))`,
    "  scope: deploymentRegistry",
    "  properties: {",
    "    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')",
    `    principalId: ${symbols.identity}.properties.principalId`,
    "    principalType: 'ServicePrincipal'",
    "  }",
    "}",
  );
  context.implementationOutputs.set(
    resourceOutputName(resource.id, "NAME"),
    `${symbols.site}.name`,
  );
}

export function renderBotIdentity(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  const symbols = context.symbols.get(resource.id)!;
  const frontend = context.outputs.get("frontendBaseUrl");
  context.sections.push(
    "",
    `resource ${symbols.main} 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {`,
    `  name: ${azureName(context.contract.solution.name, resource.id, 128, true)}`,
    "  location: location",
    "}",
    "",
    `resource ${symbols.main}Bot 'Microsoft.BotService/botServices@2022-09-15' = {`,
    `  name: ${azureName(context.contract.solution.name, `${resource.id}-bot`, 42, true)}`,
    "  location: 'global'",
    "  kind: 'azurebot'",
    "  sku: { name: 'F0' }",
    "  properties: {",
    `    displayName: ${bicepString(context.contract.solution.name)}`,
    `    endpoint: ${frontend ? `'\${${frontend}}/api/messages'` : "''"}`,
    `    msaAppId: ${symbols.main}.properties.clientId`,
    `    msaAppTenantId: ${symbols.main}.properties.tenantId`,
    "    msaAppType: 'UserAssignedMSI'",
    `    msaAppMSIResourceId: ${symbols.main}.id`,
    "  }",
    "}",
    "",
    `resource ${symbols.main}TeamsChannel 'Microsoft.BotService/botServices/channels@2022-09-15' = {`,
    `  parent: ${symbols.main}Bot`,
    "  name: 'MsTeamsChannel'",
    "  location: 'global'",
    "  properties: { channelName: 'MsTeamsChannel', location: 'global' }",
    "}",
  );
}