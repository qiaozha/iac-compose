import {
  entraOutput,
  microsoftEntraAuthentication,
} from "../../identity/planning.js";
import {
  hyphenatedPrefix,
  hyphenatedQualifiedPrefix,
  identifier,
  pascalCase,
} from "../../names.js";
import { implementationOutput } from "../../outputs.js";
import { arrayValue, asObject, numberValue } from "../../values.js";
import type { RenderingContext } from "../context.js";

export function renderContainers(context: RenderingContext): void {
  for (const resource of context.ofKind("container-host")) {
    if (context.isHosted(resource)) continue;
    const base = identifier(resource.id);
    const configuration = asObject(resource.configuration);
    const runtimeSettings = asObject(configuration.runtimeSettings);
    const ingress = asObject(configuration.ingress);
    const publicNetworkAccessEnabled =
      Object.keys(ingress).length === 0 ||
      ingress.mode === "unrestricted" ||
      arrayValue(ingress.allowedServiceTags).length > 0;
    const entraAuthentication = microsoftEntraAuthentication(resource);
    const botIdentity = context.ofKind("bot-identity")[0];
    const attachedIdentity =
      resource.authentication === "bot-framework" && botIdentity
        ? `fn.union(\n      fn.json(fn.concat('{"', ${base}Identity.id, '":{}}')),\n      fn.json(fn.concat('{"', ${identifier(botIdentity.id)}Identity.id, '":{}}')),\n    ) as any`
        : `fn.json(fn.concat('{"', ${base}Identity.id, '":{}}')) as any`;
    if (entraAuthentication) {
      const audienceName = `${base}Audience`;
      const appIdName = `${base}ApplicationAppId`;
      const applicationAppId = context.input(
        entraOutput(resource.id, "APPLICATION_APP_ID"),
        appIdName,
      );
      context.addSection(`const ${appIdName} = ${applicationAppId};
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
          `{ name: ${JSON.stringify(name)}, value: ${context.renderValue(value)} }`,
      ),
    ];
    context.addSection(`const ${base}Identity = new UserAssignedIdentity(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), `${resource.id}-identity`, 116))}, suffix),
  location,
});

const ${base}Plan = new AppServicePlan(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedQualifiedPrefix(context.solutionName(), resource.id, "p", 32))}, suffix),
  location,
  kind: "linux",
  sku: { name: "B1", tier: "Basic", capacity: 1 },
  properties: { reserved: true },
});

const ${base}Site = new Site(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), resource.id, 52))}, suffix),
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
    ${publicNetworkAccessEnabled ? 'publicNetworkAccess: "Enabled",\n    ' : ""}siteConfig: {
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
      context.addSection(`new SiteConfigAuthsettingsV2(${base}Site, {
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
    if (!context.hasExplicitRegistryAccess(resource)) {
      context.addSection(`new RoleAssignment(deploymentRegistry, {
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
    context.outputs.set(implementationOutput(resource.id, "NAME"), `${base}Site.name`);
  }
}

export function renderBots(context: RenderingContext): void {
  for (const resource of context.ofKind("bot-identity")) {
    const base = identifier(resource.id);
    const frontend = context.outputs.get("frontendBaseUrl") ?? JSON.stringify("");
    context.addSection(`const ${base}Bot = new Bot(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), `${resource.id}-bot`, 35))}, suffix),
  location: "global",
  kind: "azurebot",
  sku: { name: "F0" },
  properties: {
    displayName: ${JSON.stringify(context.solutionName())},
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

export function renderConnections(context: RenderingContext): void {
  for (const resource of context.ofKind("authorized-api-connection")) {
    const base = identifier(resource.id);
    const createParameter = `create${pascalCase(resource.id)}`;
    context.addSection(`const ${base}ManagedApiId = fn.concat(
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
    context.outputs.set(implementationOutput(resource.id, "NAME"), JSON.stringify("teams"));
  }
}