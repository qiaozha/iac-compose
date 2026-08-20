import type {
  RenderResourceRequirementsOptions,
  ResourceContract,
  ResourceContractRequirement,
} from "../../../shared/contracts/resources/types.js";
import {
  applicationAudience,
  azureName,
  baseUrl,
  bicepString,
  requiredOutputExpression,
  typescriptIdentifier,
  uniqueSymbol,
} from "./syntax.js";

export interface ResourceSymbols {
  readonly main?: string;
  readonly identity?: string;
  readonly site?: string;
  readonly application?: string;
  readonly servicePrincipal?: string;
  readonly database?: string;
  readonly project?: string;
  readonly workflowName?: string;
}

export interface BicepResourcePlan {
  readonly symbols: Map<string, ResourceSymbols>;
  readonly outputs: Map<string, string>;
}

export function planBicepResources(
  contract: ResourceContract,
  options: RenderResourceRequirementsOptions,
): BicepResourcePlan {
  const symbols = createResourceSymbols(contract);
  const outputs = new Map<string, string>();
  for (const resource of contract.resources) {
    for (const output of resource.produces ?? []) {
      if (outputs.has(output)) {
        throw new Error(`Output '${output}' is produced more than once.`);
      }
      outputs.set(
        output,
        outputExpression(contract, options, symbols, resource, output),
      );
    }
  }
  return { symbols, outputs };
}

export function isHostedAgentResource(
  resource: ResourceContractRequirement,
  options: RenderResourceRequirementsOptions,
): boolean {
  return (
    resource.kind === "container-host" &&
    resource.requiredBy.some(
      (component) => options.componentKinds?.[component] === "hosted-agent",
    )
  );
}

export function hasHostedAgentResource(
  contract: ResourceContract,
  options: RenderResourceRequirementsOptions,
): boolean {
  return contract.resources.some((resource) =>
    isHostedAgentResource(resource, options),
  );
}

function createResourceSymbols(
  contract: ResourceContract,
): Map<string, ResourceSymbols> {
  const symbolsByResource = new Map<string, ResourceSymbols>();
  const used = new Set<string>();
  for (const resource of contract.resources) {
    const base = uniqueSymbol(typescriptIdentifier(resource.id), used);
    const symbols: ResourceSymbols = { main: base };
    if (resource.kind === "document-database") {
      symbolsByResource.set(resource.id, {
        ...symbols,
        database: uniqueSymbol(`${base}Database`, used),
      });
    } else if (resource.kind === "ai-project") {
      symbolsByResource.set(resource.id, {
        ...symbols,
        project: uniqueSymbol(`${base}Project`, used),
      });
    } else if (resource.kind === "container-host") {
      const containerSymbols: ResourceSymbols = {
        ...symbols,
        identity: uniqueSymbol(`${base}Identity`, used),
        site: uniqueSymbol(`${base}Site`, used),
      };
      symbolsByResource.set(
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
      symbolsByResource.set(resource.id, {
        ...symbols,
        workflowName: azureName(
          contract.solution.name,
          resource.id,
          70,
          true,
        ),
      });
    } else {
      symbolsByResource.set(resource.id, symbols);
    }
  }
  return symbolsByResource;
}

function outputExpression(
  contract: ResourceContract,
  options: RenderResourceRequirementsOptions,
  symbolsByResource: ReadonlyMap<string, ResourceSymbols>,
  resource: ResourceContractRequirement,
  output: string,
): string {
  const symbols = symbolsByResource.get(resource.id)!;
  switch (resource.kind) {
    case "ai-project": {
      const expressions: Readonly<Record<string, string>> = {
        foundryProjectEndpoint:
          `'https://\${${symbols.main}.name}.services.ai.azure.com/api/projects/` +
          `\${${symbols.project}.name}'`,
        agentName: bicepString(`${contract.solution.name}-agent`),
        agentVersion: hasHostedAgentResource(contract, options) ? "''" : "'1'",
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
      if (isHostedAgentResource(resource, options)) {
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
            ? applicationAudience(contract.solution.name, resource.id)
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
        teamsAppId:
          `guid(subscription().id, resourceGroup().id, ${bicepString(resource.id)})`,
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