import type { ResourceContractRequirement } from "../../../shared/contracts/resources/types.js";
import type { BicepRenderContext } from "./context.js";
import {
  asObject,
  azureName,
  bicepString,
  optionalArray,
  optionalString,
  positiveInteger,
  requiredString,
  resourceOutputName,
} from "./syntax.js";

export function renderRegistry(context: BicepRenderContext): void {
  const name = azureName(
    context.contract.solution.name,
    "registry",
    50,
    false,
  );
  context.sections.push(
    "",
    "resource deploymentRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {",
    `  name: ${name}`,
    "  location: location",
    "  sku: { name: 'Basic' }",
    "  properties: { adminUserEnabled: false }",
    "}",
  );
  context.implementationOutputs.set(
    "DEPLOY_REGISTRY_NAME",
    "deploymentRegistry.name",
  );
  context.implementationOutputs.set(
    "AZURE_CONTAINER_REGISTRY_ENDPOINT",
    "deploymentRegistry.properties.loginServer",
  );
}

export function renderAiProject(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  const symbols = context.symbols.get(resource.id)!;
  const model = optionalString(resource.configuration?.model) ?? "gpt-4.1-mini";
  const accountName = azureName(
    context.contract.solution.name,
    `${resource.id}-ai`,
    64,
    true,
  );
  const projectName = azureName(
    context.contract.solution.name,
    `${resource.id}-project`,
    64,
    true,
  );
  context.sections.push(
    "",
    `resource ${symbols.main} 'Microsoft.CognitiveServices/accounts@2025-06-01' = {`,
    `  name: ${accountName}`,
    "  location: location",
    "  kind: 'AIServices'",
    "  identity: { type: 'SystemAssigned' }",
    "  sku: { name: 'S0' }",
    "  properties: {",
    `    customSubDomainName: ${accountName}`,
    "    allowProjectManagement: true",
    `    defaultProject: ${projectName}`,
    "    publicNetworkAccess: 'Enabled'",
    "    disableLocalAuth: true",
    "  }",
    "}",
    "",
    `resource ${symbols.project} 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {`,
    `  parent: ${symbols.main}`,
    `  name: ${projectName}`,
    "  location: location",
    "  identity: { type: 'SystemAssigned' }",
    "  properties: {}",
    "}",
    "",
    `resource ${symbols.main}Model 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {`,
    `  parent: ${symbols.main}`,
    `  name: ${bicepString(model)}`,
    "  sku: {",
    "    name: 'GlobalStandard'",
    "    capacity: 1",
    "  }",
    "  properties: {",
    "    model: {",
    "      format: 'OpenAI'",
    `      name: ${bicepString(model)}`,
    "      version: '2025-04-14'",
    "    }",
    "    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'",
    "  }",
    "}",
  );
  if (context.hasHostedAgent()) {
    context.sections.push(
      "",
      `resource ${symbols.main}ProjectAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {`,
      `  name: guid(deploymentRegistry.id, ${symbols.project}.id, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d'))`,
      "  scope: deploymentRegistry",
      "  properties: {",
      "    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')",
      `    principalId: ${symbols.project}.identity.principalId`,
      "    principalType: 'ServicePrincipal'",
      "  }",
      "}",
    );
  }
  context.implementationOutputs.set(
    "AZURE_AI_PROJECT_ID",
    `${symbols.project}.id`,
  );
  context.implementationOutputs.set(
    "FOUNDRY_PROJECT_ENDPOINT",
    `'https://\${${symbols.main}.name}.services.ai.azure.com/api/projects/\${${symbols.project}.name}'`,
  );
}

export function renderDocumentDatabase(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  const symbols = context.symbols.get(resource.id)!;
  const configuration = asObject(resource.configuration);
  const databaseName = optionalString(configuration.database) ?? resource.id;
  context.sections.push(
    "",
    `resource ${symbols.main} 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {`,
    `  name: ${azureName(context.contract.solution.name, resource.id, 44, false)}`,
    "  location: location",
    "  kind: 'GlobalDocumentDB'",
    "  properties: {",
    "    databaseAccountOfferType: 'Standard'",
    "    disableLocalAuth: true",
    "    publicNetworkAccess: 'Enabled'",
    "    minimalTlsVersion: 'Tls12'",
    "    consistencyPolicy: { defaultConsistencyLevel: 'Session' }",
    "    locations: [",
    "      { locationName: location, failoverPriority: 0, isZoneRedundant: false }",
    "    ]",
    "  }",
    "}",
    "",
    `resource ${symbols.database} 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {`,
    `  parent: ${symbols.main}`,
    `  name: ${bicepString(databaseName)}`,
    "  properties: {",
    `    resource: { id: ${bicepString(databaseName)} }`,
    `    options: { throughput: ${positiveInteger(configuration.throughput, 400)} }`,
    "  }",
    "}",
  );
  const containers = optionalArray(configuration.containers);
  containers.forEach((containerValue, index) => {
    const container = asObject(containerValue);
    const name = requiredString(
      container.name,
      `${resource.id}.configuration.containers[${index}].name`,
    );
    const partitionKey = requiredString(
      container.partitionKey,
      `${resource.id}.configuration.containers[${index}].partitionKey`,
    );
    context.sections.push(
      "",
      `resource ${symbols.main}Container${index + 1} 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {`,
      `  parent: ${symbols.database}`,
      `  name: ${bicepString(name)}`,
      "  properties: {",
      "    resource: {",
      `      id: ${bicepString(name)}`,
      "      partitionKey: {",
      `        paths: [${bicepString(partitionKey)}]`,
      "        kind: 'Hash'",
      "        version: 2",
      "      }",
      "    }",
      "  }",
      "}",
    );
  });
}

export function renderObjectStorage(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  const symbols = context.symbols.get(resource.id)!;
  context.sections.push(
    "",
    `resource ${symbols.main} 'Microsoft.Storage/storageAccounts@2023-05-01' = {`,
    `  name: ${azureName(context.contract.solution.name, resource.id, 24, false)}`,
    "  location: location",
    "  kind: 'StorageV2'",
    "  sku: { name: 'Standard_LRS' }",
    "  properties: {",
    "    minimumTlsVersion: 'TLS1_2'",
    "    allowBlobPublicAccess: false",
    "    supportsHttpsTrafficOnly: true",
    "  }",
    "}",
  );
  const containers = optionalArray(asObject(resource.configuration).containers);
  if (containers.length === 0) return;
  context.sections.push(
    "",
    `resource ${symbols.main}BlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {`,
    `  parent: ${symbols.main}`,
    "  name: 'default'",
    "}",
  );
  containers.forEach((container, index) => {
    const name = requiredString(
      container,
      `${resource.id}.configuration.containers[${index}]`,
    );
    context.sections.push(
      "",
      `resource ${symbols.main}Container${index + 1} 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {`,
      `  parent: ${symbols.main}BlobService`,
      `  name: ${bicepString(name)}`,
      "  properties: { publicAccess: 'None' }",
      "}",
    );
  });
}

export function renderConfigurationStore(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  const symbols = context.symbols.get(resource.id)!;
  context.sections.push(
    "",
    `resource ${symbols.main} 'Microsoft.AppConfiguration/configurationStores@2024-05-01' = {`,
    `  name: ${azureName(context.contract.solution.name, resource.id, 50, true)}`,
    "  location: location",
    "  sku: { name: 'standard' }",
    "  properties: {",
    "    disableLocalAuth: true",
    "    publicNetworkAccess: 'Enabled'",
    "  }",
    "}",
  );
  const values = asObject(asObject(resource.configuration).values);
  Object.entries(values)
    .filter(([, value]) => !context.containsDeferredOutput(value))
    .forEach(([key, value], index) => {
      context.sections.push(
        "",
        `resource ${symbols.main}Value${index + 1} 'Microsoft.AppConfiguration/configurationStores/keyValues@2024-05-01' = {`,
        `  parent: ${symbols.main}`,
        `  name: ${bicepString(key)}`,
        "  properties: {",
        `    value: ${context.renderValue(value)}`,
        "  }",
        "}",
      );
    });
  context.implementationOutputs.set(
    resourceOutputName(resource.id, "NAME"),
    `${symbols.main}.name`,
  );
}

export function renderApplicationMonitoring(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  const symbols = context.symbols.get(resource.id)!;
  context.sections.push(
    "",
    `resource ${symbols.main}Workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {`,
    `  name: ${azureName(context.contract.solution.name, `${resource.id}-logs`, 63, true)}`,
    "  location: location",
    "  properties: {",
    "    retentionInDays: 30",
    "    sku: { name: 'PerGB2018' }",
    "  }",
    "}",
    "",
    `resource ${symbols.main} 'Microsoft.Insights/components@2020-02-02' = {`,
    `  name: ${azureName(context.contract.solution.name, resource.id, 100, true)}`,
    "  location: location",
    "  kind: 'web'",
    "  properties: {",
    "    Application_Type: 'web'",
    `    WorkspaceResourceId: ${symbols.main}Workspace.id`,
    "  }",
    "}",
  );
}