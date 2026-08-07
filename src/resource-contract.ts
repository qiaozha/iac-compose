export interface ResourceContractRequirement {
  readonly id: string;
  readonly kind: string;
  readonly requiredBy: readonly string[];
  readonly produces?: readonly string[];
  readonly source?: string;
  readonly access?: readonly {
    readonly principalOutput: string;
    readonly role: string;
  }[];
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly containerPort?: number;
  readonly healthPath?: string;
  readonly authentication?: string;
  readonly authorization?: string;
  readonly [key: string]: unknown;
}

export interface ResourceContract {
  readonly schemaVersion: string;
  readonly solution: {
    readonly name: string;
    readonly enabledComponents: readonly string[];
  };
  readonly resources: readonly ResourceContractRequirement[];
  readonly [key: string]: unknown;
}

export interface RenderResourceRequirementsOptions {
  readonly templates?: Readonly<Record<string, unknown>>;
  readonly componentKinds?: Readonly<Record<string, string>>;
}

export interface RenderedProvisioningFile {
  readonly path: string;
  readonly contents: string;
}

interface ResourceSymbols {
  readonly main?: string;
  readonly identity?: string;
  readonly site?: string;
  readonly application?: string;
  readonly servicePrincipal?: string;
  readonly database?: string;
  readonly project?: string;
  readonly workflowName?: string;
}

const supportedResourceKinds = new Set([
  "ai-project",
  "application-monitoring",
  "authorized-api-connection",
  "bot-identity",
  "configuration-store",
  "container-host",
  "document-database",
  "object-storage",
  "teams-application",
  "workflow-host",
]);

const roleDefinitionIds: Readonly<Record<string, string>> = {
  "App Configuration Data Reader": "516239f1-63e1-4d78-a4de-a74fb236a071",
  "Azure AI User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Foundry User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Storage Blob Data Contributor": "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
};

export function renderResourceRequirements(
  contract: ResourceContract,
  options: RenderResourceRequirementsOptions = {},
): readonly RenderedProvisioningFile[] {
  validateContract(contract);
  const renderer = new ResourceContractRenderer(contract, options);
  return renderer.render();
}

class ResourceContractRenderer {
  readonly #contract: ResourceContract;
  readonly #options: RenderResourceRequirementsOptions;
  readonly #symbols = new Map<string, ResourceSymbols>();
  readonly #outputs = new Map<string, string>();
  readonly #sections: string[] = [];
  readonly #implementationOutputs = new Map<string, string>();
  #roleAssignmentIndex = 0;

  constructor(
    contract: ResourceContract,
    options: RenderResourceRequirementsOptions,
  ) {
    this.#contract = contract;
    this.#options = options;
    this.#registerSymbols();
    this.#registerOutputs();
  }

  render(): readonly RenderedProvisioningFile[] {
    this.#sections.push("targetScope = 'resourceGroup'", "", "param location string");
    for (const resource of this.#interactiveConnections()) {
      this.#sections.push(
        "",
        `param ${this.#connectionCreateParameter(resource)} bool`,
      );
    }
    this.#sections.push(
      "",
      "var suffix = substring(uniqueString(resourceGroup().id), 0, 6)",
    );
    if (this.#contract.resources.some((resource) => resource.kind === "container-host")) {
      this.#renderRegistry();
    }
    for (const resource of this.#contract.resources) this.#renderResource(resource);
    for (const resource of this.#contract.resources) this.#renderAccess(resource);
    this.#renderOutputs();
    if (
      this.#contract.resources.some(
        (resource) => resource.authentication === "managed-identity",
      )
    ) {
      this.#sections.push(
        "",
        "extension 'br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:1.0.0'",
      );
    }

    const files: RenderedProvisioningFile[] = [
      {
        path: "main.bicep",
        contents: `${this.#sections.join("\n")}\n`,
      },
      {
        path: "main.bicepparam",
        contents:
          "using './main.bicep'\n\n" +
          "param location = readEnvironmentVariable('AZURE_LOCATION', 'westus2')\n" +
          this.#interactiveConnections()
            .map(
              (resource) =>
                `param ${this.#connectionCreateParameter(resource)} = ` +
                `readEnvironmentVariable('${resourceCreateEnvironmentName(resource.id)}', 'true') == 'true'\n`,
            )
            .join(""),
      },
    ];
    for (const resource of this.#contract.resources) {
      if (resource.kind !== "workflow-host") continue;
      const template = this.#options.templates?.[resource.id];
      if (template === undefined) {
        throw new Error(
          `Workflow resource '${resource.id}' requires its source template during rendering.`,
        );
      }
      files.push({
        path: `templates/${safeFileName(resource.id)}.json`,
        contents: `${JSON.stringify(template, null, 2)}\n`,
      });
    }
    return files;
  }

  #registerSymbols(): void {
    const used = new Set<string>();
    for (const resource of this.#contract.resources) {
      const base = uniqueSymbol(typescriptIdentifier(resource.id), used);
      const symbols: ResourceSymbols = { main: base };
      if (resource.kind === "document-database") {
        this.#symbols.set(resource.id, {
          ...symbols,
          database: uniqueSymbol(`${base}Database`, used),
        });
      } else if (resource.kind === "ai-project") {
        this.#symbols.set(resource.id, {
          ...symbols,
          project: uniqueSymbol(`${base}Project`, used),
        });
      } else if (resource.kind === "container-host") {
        const containerSymbols: ResourceSymbols = {
          ...symbols,
          identity: uniqueSymbol(`${base}Identity`, used),
          site: uniqueSymbol(`${base}Site`, used),
        };
        this.#symbols.set(
          resource.id,
          resource.authentication === "managed-identity"
            ? {
                ...containerSymbols,
                application: uniqueSymbol(`${base}Application`, used),
                servicePrincipal: uniqueSymbol(
                  `${base}ServicePrincipal`,
                  used,
                ),
              }
            : containerSymbols,
        );
      } else if (resource.kind === "workflow-host") {
        this.#symbols.set(resource.id, {
          ...symbols,
          workflowName: azureName(
            this.#contract.solution.name,
            resource.id,
            70,
            true,
          ),
        });
      } else {
        this.#symbols.set(resource.id, symbols);
      }
    }
  }

  #registerOutputs(): void {
    for (const resource of this.#contract.resources) {
      for (const output of resource.produces ?? []) {
        if (this.#outputs.has(output)) {
          throw new Error(`Output '${output}' is produced more than once.`);
        }
        this.#outputs.set(output, this.#outputExpression(resource, output));
      }
    }
  }

  #outputExpression(resource: ResourceContractRequirement, output: string): string {
    const symbols = this.#symbols.get(resource.id)!;
    switch (resource.kind) {
      case "ai-project": {
        const expressions: Readonly<Record<string, string>> = {
          foundryProjectEndpoint:
            `'https://\${${symbols.main}.name}.services.ai.azure.com/api/projects/` +
            `\${${symbols.project}.name}'`,
          agentName: bicepString(`${this.#contract.solution.name}-agent`),
          agentVersion: this.#hasHostedAgent() ? "''" : "'1'",
        };
        return requiredOutputExpression(resource, output, expressions);
      }
      case "document-database":
        return requiredOutputExpression(resource, output, {
          cosmosEndpoint: `${symbols.main}.properties.documentEndpoint`,
          cosmosDatabase: `${symbols.database}.name`,
          cosmosAccountName: `${symbols.main}.name`,
          cosmosAccountResourceId: `${symbols.main}.id`,
        });
      case "object-storage":
        return requiredOutputExpression(resource, output, {
          storageBlobEndpoint: `${symbols.main}.properties.primaryEndpoints.blob`,
          storageAccountName: `${symbols.main}.name`,
          storageAccountResourceId: `${symbols.main}.id`,
        });
      case "configuration-store":
        return requiredOutputExpression(resource, output, {
          appConfigurationEndpoint: `${symbols.main}.properties.endpoint`,
          appConfigurationName: `${symbols.main}.name`,
          appConfigurationResourceId: `${symbols.main}.id`,
        });
      case "application-monitoring":
        return requiredOutputExpression(resource, output, {
          applicationInsightsConnectionString:
            `${symbols.main}.properties.ConnectionString`,
          applicationInsightsName: `${symbols.main}.name`,
        });
      case "container-host":
        if (this.#isHostedAgent(resource)) {
          return requiredOutputExpression(resource, output, {
            agentEndpoint: "''",
            agentIdentityClientId: "''",
            agentIdentityPrincipalId: "''",
            agentIdentityResourceId: "''",
          });
        }
        return requiredOutputExpression(resource, output, {
          agentEndpoint: baseUrl(symbols.site!),
          agentIdentityClientId: `${symbols.identity}.properties.clientId`,
          agentIdentityPrincipalId: `${symbols.identity}.properties.principalId`,
          agentIdentityResourceId: `${symbols.identity}.id`,
          backendBaseUrl: baseUrl(symbols.site!),
          backendAudience:
            resource.authentication === "managed-identity"
              ? applicationAudience(this.#contract.solution.name, resource.id)
              : `${symbols.identity}.properties.clientId`,
          backendIdentityClientId: `${symbols.identity}.properties.clientId`,
          backendIdentityPrincipalId: `${symbols.identity}.properties.principalId`,
          backendIdentityResourceId: `${symbols.identity}.id`,
          frontendBaseUrl: baseUrl(symbols.site!),
          frontendIdentityClientId: `${symbols.identity}.properties.clientId`,
          frontendIdentityPrincipalId: `${symbols.identity}.properties.principalId`,
          frontendIdentityResourceId: `${symbols.identity}.id`,
        });
      case "bot-identity":
        return requiredOutputExpression(resource, output, {
          botClientId: `${symbols.main}.properties.clientId`,
          botIdentityPrincipalId: `${symbols.main}.properties.principalId`,
          botIdentityResourceId: `${symbols.main}.id`,
          tenantId: `${symbols.main}.properties.tenantId`,
        });
      case "teams-application":
        return requiredOutputExpression(resource, output, {
          teamsAppId: `guid(subscription().id, resourceGroup().id, ${bicepString(resource.id)})`,
        });
      case "authorized-api-connection":
        return requiredOutputExpression(resource, output, {
          teamsConnectionResourceId:
            "resourceId('Microsoft.Web/connections', 'teams')",
          connectionResourceId:
            "resourceId('Microsoft.Web/connections', 'teams')",
        });
      case "workflow-host":
        throw new Error(
          `Workflow resource '${resource.id}' cannot produce contract output '${output}'.`,
        );
      default:
        throw new Error(`Unsupported resource kind '${resource.kind}'.`);
    }
  }

  #renderRegistry(): void {
    const name = azureName(
      this.#contract.solution.name,
      "registry",
      50,
      false,
    );
    this.#sections.push(
      "",
      `resource deploymentRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {`,
      `  name: ${name}`,
      "  location: location",
      "  sku: { name: 'Basic' }",
      "  properties: { adminUserEnabled: false }",
      "}",
    );
    this.#implementationOutputs.set("DEPLOY_REGISTRY_NAME", "deploymentRegistry.name");
    this.#implementationOutputs.set(
      "AZURE_CONTAINER_REGISTRY_ENDPOINT",
      "deploymentRegistry.properties.loginServer",
    );
  }

  #renderResource(resource: ResourceContractRequirement): void {
    switch (resource.kind) {
      case "ai-project":
        this.#renderAiProject(resource);
        break;
      case "document-database":
        this.#renderDocumentDatabase(resource);
        break;
      case "object-storage":
        this.#renderObjectStorage(resource);
        break;
      case "configuration-store":
        this.#renderConfigurationStore(resource);
        break;
      case "application-monitoring":
        this.#renderApplicationMonitoring(resource);
        break;
      case "container-host":
        this.#renderContainerHost(resource);
        break;
      case "bot-identity":
        this.#renderBotIdentity(resource);
        break;
      case "teams-application":
        break;
      case "authorized-api-connection":
        this.#renderAuthorizedConnection(resource);
        break;
      case "workflow-host":
        this.#renderWorkflow(resource);
        break;
      default:
        throw new Error(`Unsupported resource kind '${resource.kind}'.`);
    }
  }

  #renderAiProject(resource: ResourceContractRequirement): void {
    const symbols = this.#symbols.get(resource.id)!;
    const model = optionalString(resource.configuration?.model) ?? "gpt-4.1-mini";
    const accountName = azureName(
      this.#contract.solution.name,
      `${resource.id}-ai`,
      64,
      true,
    );
    const projectName = azureName(
      this.#contract.solution.name,
      `${resource.id}-project`,
      64,
      true,
    );
    this.#sections.push(
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
    if (this.#contract.resources.some((candidate) => this.#isHostedAgent(candidate))) {
      this.#sections.push(
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
    this.#implementationOutputs.set("AZURE_AI_PROJECT_ID", `${symbols.project}.id`);
    this.#implementationOutputs.set(
      "FOUNDRY_PROJECT_ENDPOINT",
      `'https://\${${symbols.main}.name}.services.ai.azure.com/api/projects/\${${symbols.project}.name}'`,
    );
  }

  #renderDocumentDatabase(resource: ResourceContractRequirement): void {
    const symbols = this.#symbols.get(resource.id)!;
    const configuration = asObject(resource.configuration);
    const databaseName = optionalString(configuration.database) ?? resource.id;
    this.#sections.push(
      "",
      `resource ${symbols.main} 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {`,
      `  name: ${azureName(this.#contract.solution.name, resource.id, 44, false)}`,
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
      const name = requiredString(container.name, `${resource.id}.configuration.containers[${index}].name`);
      const partitionKey = requiredString(
        container.partitionKey,
        `${resource.id}.configuration.containers[${index}].partitionKey`,
      );
      this.#sections.push(
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

  #renderObjectStorage(resource: ResourceContractRequirement): void {
    const symbols = this.#symbols.get(resource.id)!;
    this.#sections.push(
      "",
      `resource ${symbols.main} 'Microsoft.Storage/storageAccounts@2023-05-01' = {`,
      `  name: ${azureName(this.#contract.solution.name, resource.id, 24, false)}`,
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
    if (containers.length > 0) {
      this.#sections.push(
        "",
        `resource ${symbols.main}BlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {`,
        `  parent: ${symbols.main}`,
        "  name: 'default'",
        "}",
      );
      containers.forEach((container, index) => {
        const name = requiredString(container, `${resource.id}.configuration.containers[${index}]`);
        this.#sections.push(
          "",
          `resource ${symbols.main}Container${index + 1} 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {`,
          `  parent: ${symbols.main}BlobService`,
          `  name: ${bicepString(name)}`,
          "  properties: { publicAccess: 'None' }",
          "}",
        );
      });
    }
  }

  #renderConfigurationStore(resource: ResourceContractRequirement): void {
    const symbols = this.#symbols.get(resource.id)!;
    this.#sections.push(
      "",
      `resource ${symbols.main} 'Microsoft.AppConfiguration/configurationStores@2024-05-01' = {`,
      `  name: ${azureName(this.#contract.solution.name, resource.id, 50, true)}`,
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
      .filter(([, value]) => !this.#containsDeferredOutput(value))
      .forEach(([key, value], index) => {
      this.#sections.push(
        "",
        `resource ${symbols.main}Value${index + 1} 'Microsoft.AppConfiguration/configurationStores/keyValues@2024-05-01' = {`,
        `  parent: ${symbols.main}`,
        `  name: ${bicepString(key)}`,
        "  properties: {",
        `    value: ${this.#renderValue(value)}`,
        "  }",
        "}",
      );
      });
    this.#implementationOutputs.set(
      resourceOutputName(resource.id, "NAME"),
      `${symbols.main}.name`,
    );
  }

  #renderApplicationMonitoring(resource: ResourceContractRequirement): void {
    const symbols = this.#symbols.get(resource.id)!;
    this.#sections.push(
      "",
      `resource ${symbols.main}Workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {`,
      `  name: ${azureName(this.#contract.solution.name, `${resource.id}-logs`, 63, true)}`,
      "  location: location",
      "  properties: {",
      "    retentionInDays: 30",
      "    sku: { name: 'PerGB2018' }",
      "  }",
      "}",
      "",
      `resource ${symbols.main} 'Microsoft.Insights/components@2020-02-02' = {`,
      `  name: ${azureName(this.#contract.solution.name, resource.id, 100, true)}`,
      "  location: location",
      "  kind: 'web'",
      "  properties: {",
      "    Application_Type: 'web'",
      `    WorkspaceResourceId: ${symbols.main}Workspace.id`,
      "  }",
      "}",
    );
  }

  #renderContainerHost(resource: ResourceContractRequirement): void {
    if (this.#isHostedAgent(resource)) return;
    const symbols = this.#symbols.get(resource.id)!;
    const siteName = azureName(
      this.#contract.solution.name,
      resource.id,
      60,
      true,
    );
    const runtimeSettings = asObject(asObject(resource.configuration).runtimeSettings);
    const audience = applicationAudience(
      this.#contract.solution.name,
      resource.id,
    );
    const appSettings = [
      { name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE", value: "false" },
      { name: "WEBSITES_PORT", value: String(resource.containerPort ?? 8080) },
      ...Object.entries(runtimeSettings).map(([name, value]) => ({ name, value })),
    ];
    const attachedIdentities = [`'\${${symbols.identity}.id}': {}`];
    if (resource.authentication === "bot-framework" && this.#outputs.has("botIdentityResourceId")) {
      attachedIdentities.push(
        `'\${${this.#outputs.get("botIdentityResourceId")!}}': {}`,
      );
    }
    if (resource.authentication === "managed-identity") {
      this.#sections.push(
        "",
        `resource ${symbols.application} 'Microsoft.Graph/applications@v1.0' = {`,
        `  uniqueName: ${azureName(this.#contract.solution.name, `${resource.id}-api`, 90, true)}`,
        `  displayName: ${bicepString(`${this.#contract.solution.name} ${resource.id} API`)}`,
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
    this.#sections.push(
      "",
      `resource ${symbols.identity} 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {`,
      `  name: ${azureName(this.#contract.solution.name, `${resource.id}-identity`, 128, true)}`,
      "  location: location",
      "}",
      "",
      `resource ${symbols.main}Plan 'Microsoft.Web/serverfarms@2023-12-01' = {`,
      `  name: ${azureName(this.#contract.solution.name, `${resource.id}-plan`, 40, true)}`,
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
          `        { name: ${bicepString(setting.name)}, value: ${this.#renderValue(setting.value)} }`,
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
    this.#implementationOutputs.set(
      resourceOutputName(resource.id, "NAME"),
      `${symbols.site}.name`,
    );
  }

  #renderBotIdentity(resource: ResourceContractRequirement): void {
    const symbols = this.#symbols.get(resource.id)!;
    const frontend = this.#outputs.get("frontendBaseUrl");
    this.#sections.push(
      "",
      `resource ${symbols.main} 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {`,
      `  name: ${azureName(this.#contract.solution.name, resource.id, 128, true)}`,
      "  location: location",
      "}",
      "",
      `resource ${symbols.main}Bot 'Microsoft.BotService/botServices@2022-09-15' = {`,
      `  name: ${azureName(this.#contract.solution.name, `${resource.id}-bot`, 64, true)}`,
      "  location: 'global'",
      "  kind: 'azurebot'",
      "  sku: { name: 'F0' }",
      "  properties: {",
      `    displayName: ${bicepString(this.#contract.solution.name)}`,
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

  #renderAuthorizedConnection(resource: ResourceContractRequirement): void {
    const symbols = this.#symbols.get(resource.id)!;
    this.#sections.push(
      "",
      `resource ${symbols.main} 'Microsoft.Web/connections@2016-06-01' = if (${this.#connectionCreateParameter(resource)}) {`,
      "  name: 'teams'",
      "  location: location",
      "  properties: {",
      "    displayName: 'teams'",
      "    api: {",
      "      id: '/subscriptions/${subscription().subscriptionId}/providers/Microsoft.Web/locations/${location}/managedApis/teams'",
      "    }",
      "    parameterValues: {}",
      "  }",
      "}",
    );
    this.#implementationOutputs.set(
      resourceOutputName(resource.id, "NAME"),
      "'teams'",
    );
  }

  #interactiveConnections(): readonly ResourceContractRequirement[] {
    return this.#contract.resources.filter(
      (resource) =>
        resource.kind === "authorized-api-connection" &&
        resource.authorization === "interactive",
    );
  }

  #connectionCreateParameter(resource: ResourceContractRequirement): string {
    const symbol = this.#symbols.get(resource.id)!.main!;
    return `create${symbol.charAt(0).toUpperCase()}${symbol.slice(1)}`;
  }

  #renderWorkflow(resource: ResourceContractRequirement): void {
    const symbols = this.#symbols.get(resource.id)!;
    const template = asObject(this.#options.templates?.[resource.id]);
    const templateParameters = asObject(template.parameters);
    const supplied = asObject(asObject(resource.parameters).parameters);
    const parameters: Record<string, unknown> = { ...supplied };
    if ("logicAppName" in templateParameters && !("logicAppName" in parameters)) {
      parameters.logicAppName = { value: { expression: symbols.workflowName! } };
    }
    if ("logicAppState" in templateParameters && !("logicAppState" in parameters)) {
      parameters.logicAppState = { value: "Disabled" };
    }
    if ("location" in templateParameters && !("location" in parameters)) {
      parameters.location = { value: { expression: "location" } };
    }
    this.#sections.push(
      "",
      `module ${symbols.main} './templates/${safeFileName(resource.id)}.json' = {`,
      `  name: ${azureName(this.#contract.solution.name, `${resource.id}-deployment`, 64, true)}`,
      "  params: {",
      ...Object.entries(parameters).map(([name, parameter]) => {
        const value = asObject(parameter).value;
        return `    ${bicepProperty(name)}: ${this.#renderParameterValue(value)}`;
      }),
      "  }",
      "}",
    );
    this.#implementationOutputs.set(
      resourceOutputName(resource.id, "NAME"),
      symbols.workflowName!,
    );
  }

  #renderAccess(resource: ResourceContractRequirement): void {
    const access = resource.access ?? [];
    if (access.length === 0) return;
    const scope = this.#accessScope(resource);
    for (const grant of access) {
      if (this.#isDeferredPrincipal(grant.principalOutput)) {
        this.#implementationOutputs.set(
          resourceOutputName(resource.id, "ACCESS_SCOPE"),
          `${this.#accessScope(resource)}.id`,
        );
        continue;
      }
      const principalId = this.#outputs.get(grant.principalOutput);
      if (!principalId) {
        throw new Error(
          `Resource '${resource.id}' grants '${grant.role}' to unknown output '${grant.principalOutput}'.`,
        );
      }
      const principalKey = this.#principalKey(grant.principalOutput);
      this.#roleAssignmentIndex += 1;
      if (grant.role === "Cosmos DB Built-in Data Contributor") {
        if (resource.kind !== "document-database") {
          throw new Error(`Role '${grant.role}' requires a document-database resource.`);
        }
        this.#sections.push(
          "",
          `resource contractCosmosRole${this.#roleAssignmentIndex} 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {`,
          `  parent: ${scope}`,
          `  name: guid(${scope}.id, ${principalKey}, '00000000-0000-0000-0000-000000000002')`,
          "  properties: {",
          `    roleDefinitionId: '\${${scope}.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'`,
          `    principalId: ${principalId}`,
          `    scope: ${scope}.id`,
          "  }",
          "}",
        );
        continue;
      }
      const roleId = roleDefinitionIds[grant.role];
      if (!roleId) {
        throw new Error(
          `Resource '${resource.id}' uses unsupported Azure role '${grant.role}'.`,
        );
      }
      this.#sections.push(
        "",
        `resource contractRole${this.#roleAssignmentIndex} 'Microsoft.Authorization/roleAssignments@2022-04-01' = {`,
        `  name: guid(${scope}.id, ${principalKey}, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${roleId}'))`,
        `  scope: ${scope}`,
        "  properties: {",
        `    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${roleId}')`,
        `    principalId: ${principalId}`,
        "    principalType: 'ServicePrincipal'",
        "  }",
        "}",
      );
    }
  }

  #accessScope(resource: ResourceContractRequirement): string {
    const symbols = this.#symbols.get(resource.id)!;
    return resource.kind === "ai-project" ? symbols.project! : symbols.main!;
  }

  #principalKey(output: string): string {
    const producer = this.#contract.resources.find((resource) =>
      resource.produces?.includes(output),
    );
    if (!producer) throw new Error(`Principal output '${output}' has no producer.`);
    const symbols = this.#symbols.get(producer.id)!;
    if (producer.kind === "container-host") return `${symbols.identity}.id`;
    if (producer.kind === "bot-identity") return `${symbols.main}.id`;
    throw new Error(
      `Principal output '${output}' is produced by unsupported kind '${producer.kind}'.`,
    );
  }

  #isDeferredPrincipal(output: string): boolean {
    const producer = this.#contract.resources.find((resource) =>
      resource.produces?.includes(output),
    );
    return producer !== undefined && this.#isHostedAgent(producer);
  }

  #isHostedAgent(resource: ResourceContractRequirement): boolean {
    return (
      resource.kind === "container-host" &&
      resource.requiredBy.some(
        (component) => this.#options.componentKinds?.[component] === "hosted-agent",
      )
    );
  }

  #hasHostedAgent(): boolean {
    return this.#contract.resources.some((resource) => this.#isHostedAgent(resource));
  }

  #containsDeferredOutput(value: unknown): boolean {
    if (!this.#hasHostedAgent()) return false;
    const source = JSON.stringify(value);
    if (!source) return false;
    return [...source.matchAll(/\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g)].some(
      (match) => match[1] === "agentVersion",
    );
  }

  #renderOutputs(): void {
    for (const [name, expression] of this.#outputs) {
      this.#sections.push("", `output ${bicepIdentifier(name)} string = ${expression}`);
    }
    for (const [name, expression] of this.#implementationOutputs) {
      if (this.#outputs.has(name)) continue;
      this.#sections.push("", `output ${name} string = ${expression}`);
    }
  }

  #renderValue(value: unknown): string {
    if (typeof value === "string") return this.#renderString(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value === null) return "null";
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.#renderValue(item)).join(", ")}]`;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      return `{ ${entries
        .map(([key, item]) => `${this.#renderObjectKey(key)}: ${this.#renderValue(item)}`)
        .join(", ")} }`;
    }
    throw new Error(`Cannot render resource value of type '${typeof value}'.`);
  }

  #renderParameterValue(value: unknown): string {
    const object = asObject(value);
    if (typeof object.expression === "string") return object.expression;
    return this.#renderValue(value);
  }

  #renderString(value: string): string {
    const matches = [...value.matchAll(/\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g)];
    if (matches.length === 0) return bicepString(value);
    if (matches.length === 1 && matches[0]![0] === value) {
      return this.#requiredBinding(matches[0]![1]!);
    }
    let rendered = "";
    let offset = 0;
    for (const match of matches) {
      rendered += escapeBicepString(value.slice(offset, match.index));
      rendered += `\${${this.#requiredBinding(match[1]!)}}`;
      offset = match.index! + match[0].length;
    }
    rendered += escapeBicepString(value.slice(offset));
    return `'${rendered}'`;
  }

  #renderObjectKey(value: string): string {
    const match = /^\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value);
    if (match) return `'\${${this.#requiredBinding(match[1]!)}}'`;
    return this.#renderString(value);
  }

  #requiredBinding(name: string): string {
    const expression = this.#outputs.get(name);
    if (!expression) throw new Error(`Output binding '${name}' has no producing resource.`);
    return expression;
  }
}

function validateContract(contract: ResourceContract): void {
  if (contract.schemaVersion !== "1.0") {
    throw new Error(`Resource contract schemaVersion '${contract.schemaVersion}' is unsupported.`);
  }
  if (!contract.solution?.name) throw new Error("Resource contract solution.name is required.");
  if (!Array.isArray(contract.resources)) {
    throw new Error("Resource contract resources must be an array.");
  }
  const ids = new Set<string>();
  for (const resource of contract.resources) {
    if (!resource.id || !resource.kind || !Array.isArray(resource.requiredBy)) {
      throw new Error("Each resource requires id, kind, and requiredBy fields.");
    }
    if (ids.has(resource.id)) throw new Error(`Duplicate resource id '${resource.id}'.`);
    ids.add(resource.id);
    if (!supportedResourceKinds.has(resource.kind)) {
      throw new Error(`Unsupported resource kind '${resource.kind}'.`);
    }
  }
}

function requiredOutputExpression(
  resource: ResourceContractRequirement,
  output: string,
  expressions: Readonly<Record<string, string>>,
): string {
  const expression = expressions[output];
  if (!expression) {
    throw new Error(
      `Resource '${resource.id}' of kind '${resource.kind}' cannot produce output '${output}'.`,
    );
  }
  return expression;
}

function baseUrl(site: string): string {
  return `'https://\${${site}.properties.defaultHostName}'`;
}

function azureName(
  solution: string,
  resource: string,
  maximumLength: number,
  hyphenated: boolean,
): string {
  const separator = hyphenated ? "-" : "";
  const normalized = `${solution}${separator}${resource}`
    .toLowerCase()
    .replace(hyphenated ? /[^a-z0-9-]+/g : /[^a-z0-9]+/g, hyphenated ? "-" : "")
    .replace(/^-+|-+$/g, "");
  const suffixLength = 6 + separator.length;
  const prefix = normalized.slice(0, Math.max(1, maximumLength - suffixLength));
  return `'${prefix}${separator}\${suffix}'`;
}

function applicationAudience(solution: string, resource: string): string {
  const normalized = `${solution}-${resource}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return `'api://${normalized}-\${suffix}'`;
}

function resourceOutputName(resourceId: string, suffix: string): string {
  return `DEPLOY_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

function resourceCreateEnvironmentName(resourceId: string): string {
  return `DEPLOY_CREATE_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function bicepString(value: string): string {
  return `'${escapeBicepString(value)}'`;
}

function escapeBicepString(value: string): string {
  return value.replaceAll("'", "''").replaceAll("${", "\\${");
}

function bicepProperty(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : bicepString(value);
}

function bicepIdentifier(value: string): string {
  const identifier = typescriptIdentifier(value);
  if (!identifier) throw new Error(`Output '${value}' is not a valid Bicep identifier.`);
  return identifier;
}

function typescriptIdentifier(value: string): string {
  const identifier = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(identifier) ? identifier : `resource_${identifier}`;
}

function uniqueSymbol(value: string, used: Set<string>): string {
  let candidate = value || "resource";
  let index = 2;
  while (used.has(candidate)) candidate = `${value}${index++}`;
  used.add(candidate);
  return candidate;
}

function safeFileName(value: string): string {
  const name = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!name) throw new Error(`Resource id '${value}' cannot be used as a file name.`);
  return name;
}

function asObject(value: unknown): Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, any>>)
    : {};
}

function optionalArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}