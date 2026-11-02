import {
  alphanumericPrefix,
  hyphenatedPrefix,
  identifier,
} from "../../names.js";
import { implementationOutput } from "../../outputs.js";
import {
  arrayValue,
  asObject,
  positiveInteger,
  requiredObject,
  requiredString,
  stringValue,
} from "../../values.js";
import type { RenderingContext } from "../context.js";
import {
  defaultModelVersion,
  modelDeploymentName,
} from "../helpers.js";

export function renderRegistry(context: RenderingContext): void {
  if (!context.resources.some((resource) => resource.kind === "container-host")) return;
  if (context.owner !== undefined && context.owner !== "shared") {
    if (!context.ofKind("container-host").some((resource) => !context.isHosted(resource))) {
      return;
    }
    const registryName = context.input("DEPLOY_REGISTRY_NAME");
    context.addSection(`const deploymentRegistry = new Registry(stack, {
  name: ${registryName},
  existing: true,
});
`);
    return;
  }
  context.addSection(`const deploymentRegistry = new Registry(stack, {
  name: fn.concat(${JSON.stringify(alphanumericPrefix(context.solutionName(), "registry", 44))}, suffix),
  location,
  sku: { name: "Basic" },
  properties: { adminUserEnabled: false },
});
`);
  context.outputs.set("DEPLOY_REGISTRY_NAME", "deploymentRegistry.name");
  context.outputs.set(
    "AZURE_CONTAINER_REGISTRY_ENDPOINT",
    "deploymentRegistry.properties.loginServer as any",
  );
}

export function renderBotIdentities(context: RenderingContext): void {
  for (const resource of context.ofKind("bot-identity")) {
    const base = identifier(resource.id);
    context.addSection(`const ${base}Identity = new UserAssignedIdentity(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), resource.id, 116))}, suffix),
  location,
});
`);
  }
}

export function renderAiProjects(context: RenderingContext): void {
  for (const resource of context.ofKind("ai-project")) {
    const base = identifier(resource.id);
    const configuration = asObject(resource.configuration);
    const model = stringValue(configuration.model, "gpt-4.1-mini");
    const aiLocation = context.input(
      "AZURE_AI_LOCATION",
      "AZURE_AI_LOCATION",
      "eastus",
    );
    const aiLocationSuffix = `${base}LocationSuffix`;
    const hasExplicitModelDeployment = context.resources.some(
      (candidate) =>
        candidate.kind === "model-deployment" && candidate.parent === resource.id,
    );
    context.addSection(`const ${aiLocationSuffix} = stack.variables.add(
  ${JSON.stringify(aiLocationSuffix)},
  fn.substring(fn.uniqueString(fn.resourceGroup().id, ${aiLocation}), 0, 6),
);

const ${base}Account = new Account(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), `${resource.id}-ai`, 52))}, ${aiLocationSuffix}),
  location: ${aiLocation},
  kind: "AIServices",
  sku: { name: "S0" },
  identity: { type: "SystemAssigned" },
  properties: {
    customSubDomainName: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), `${resource.id}-ai`, 52))}, ${aiLocationSuffix}),
    allowProjectManagement: true,
    publicNetworkAccess: "Enabled",
    disableLocalAuth: true,
  } as any,
});

const ${base}Project = new Project(${base}Account, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), `${resource.id}-project`, 52))}, ${aiLocationSuffix}),
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
${context.hasRegistry() ? `
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
    context.outputs.set("AZURE_AI_PROJECT_ID", `${base}Project.id`);
    context.outputs.set("AI_RESOURCE_NAME", `${base}Account.name`);
    context.outputs.set("AI_PROJECT_NAME", `${base}Project.name`);
    context.outputs.set(
      "FOUNDRY_PROJECT_ENDPOINT",
      `fn.concat("https://", ${base}Account.name, ".services.ai.azure.com/api/projects/", ${base}Project.name)`,
    );
  }
}

export function renderModelDeployments(context: RenderingContext): void {
  for (const resource of context.ofKind("model-deployment")) {
    const parentId = stringValue(resource.parent, "");
    const parent = context.resources.find(
      (candidate) => candidate.id === parentId && candidate.kind === "ai-project",
    );
    if (!parent) {
      throw new Error(
        `Model deployment '${resource.id}' references unknown AI project '${parentId}'.`,
      );
    }
    context.ensureExistingResource(parent);
    const configuration = asObject(resource.configuration);
    const deploymentName = modelDeploymentName(resource);
    const model = stringValue(configuration.model, deploymentName);
    const version = stringValue(
      configuration.version,
      defaultModelVersion(),
    );
    const parentBase = identifier(parent.id);
    context.addSection(`new ModelDeployment(${parentBase}Account, {
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

export function renderDocumentDatabases(context: RenderingContext): void {
  for (const resource of context.ofKind("document-database")) {
    const base = identifier(resource.id);
    const configuration = asObject(resource.configuration);
    const databaseName = stringValue(configuration.database, resource.id);
    context.addSection(`const ${base}Account = new DatabaseAccount(stack, {
  name: fn.concat(${JSON.stringify(alphanumericPrefix(context.solutionName(), resource.id, 32))}, suffix),
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
    context.outputs.set(
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
      context.addSection(`new CosmosContainer(${base}Database, {
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

export function renderObjectStorage(context: RenderingContext): void {
  for (const resource of context.ofKind("object-storage")) {
    const base = identifier(resource.id);
    const configuration = asObject(resource.configuration);
    context.addSection(`const ${base}Account = new StorageAccount(stack, {
  name: fn.concat(${JSON.stringify(alphanumericPrefix(context.solutionName(), resource.id, 18))}, suffix),
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
    context.outputs.set(
      implementationOutput(resource.id, "NAME"),
      `${base}Account.name`,
    );
    for (const nameValue of arrayValue(configuration.containers)) {
      const name = requiredString(nameValue, `${resource.id}.configuration.containers[]`);
      context.addSection(`new StorageContainer(${base}BlobService, {
  name: ${JSON.stringify(name)},
  properties: { publicAccess: "None" },
});
`);
    }
  }
}

export function renderConfigurationStores(context: RenderingContext): void {
  for (const resource of context.ofKind("configuration-store")) {
    const base = identifier(resource.id);
    context.addSection(`const ${base}Store = new ConfigurationStore(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), resource.id, 42))}, suffix),
  location,
  sku: { name: "standard" },
  properties: {
    disableLocalAuth: true,
            publicNetworkAccess: "Enabled",
            dataPlaneProxy: { authenticationMode: "Pass-through" },
  } as any,
});
`);
    context.outputs.set(
      implementationOutput(resource.id, "NAME"),
      `${base}Store.name`,
    );
  }
}

export function renderMonitoring(context: RenderingContext): void {
  for (const resource of context.ofKind("application-monitoring")) {
    const base = identifier(resource.id);
    const hostedComponents = new Set(
      resource.requiredBy.filter(
        (component) => context.componentKinds.get(component) === "hosted-agent",
      ),
    );
    const foundryProjects = context.resources.filter(
      (candidate) =>
        candidate.kind === "ai-project" &&
        candidate.requiredBy.some((component) => hostedComponents.has(component)),
    );
    for (const project of foundryProjects) {
      if (!context.owns(project)) context.ensureExistingResource(project);
    }
    context.addSection(`const ${base}Workspace = new Workspace(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), `${resource.id}-logs`, 55))}, suffix),
  location,
  properties: {
    retentionInDays: 30,
    sku: { name: "PerGB2018" },
  } as any,
});

const ${base}Insights = new ApplicationInsightsComponent(stack, {
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), resource.id, 92))}, suffix),
  location,
  kind: "web",
  properties: {
    Application_Type: "web",
    WorkspaceResourceId: ${base}Workspace.id as any,
  },
});

${foundryProjects.map((project) => {
  const projectBase = identifier(project.id);
  return `new Resource(${projectBase}Project, {
  type: "Microsoft.CognitiveServices/accounts/projects/connections",
  apiVersion: "2025-06-01",
  name: fn.concat(${JSON.stringify(hyphenatedPrefix(context.solutionName(), `${resource.id}-${project.id}-appinsights`, 25))}, suffix),
  properties: {
    category: "AppInsights",
    target: ${base}Insights.id,
    authType: "ApiKey",
    isSharedToAll: true,
    credentials: {
      key: ${base}Insights.properties.ConnectionString as any,
    },
    metadata: {
      ApiType: "Azure",
      ResourceId: ${base}Insights.id,
    },
  },
});`;
}).join("\n\n")}
`);
    context.outputs.set(
      implementationOutput(resource.id, "NAME"),
      `${base}Insights.name`,
    );
  }
}