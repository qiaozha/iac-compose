import type { ResourceContractRequirement } from "../../../shared/contracts/resources/types.js";
import type { BicepRenderContext } from "./context.js";
import { resourceOutputName } from "./syntax.js";

const roleDefinitionIds: Readonly<Record<string, string>> = {
  "App Configuration Data Reader": "516239f1-63e1-4d78-a4de-a74fb236a071",
  "Azure AI User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Foundry User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Storage Blob Data Contributor": "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
};

export function renderResourceAccess(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  const access = resource.access ?? [];
  if (access.length === 0) return;
  const scope = accessScope(context, resource);
  for (const grant of access) {
    if (isDeferredPrincipal(context, grant.principalOutput)) {
      context.implementationOutputs.set(
        resourceOutputName(resource.id, "ACCESS_SCOPE"),
        `${accessScope(context, resource)}.id`,
      );
      continue;
    }
    const principalId = context.outputs.get(grant.principalOutput);
    if (!principalId) {
      throw new Error(
        `Resource '${resource.id}' grants '${grant.role}' to unknown output '${grant.principalOutput}'.`,
      );
    }
    const principal = principalKey(context, grant.principalOutput);
    const index = context.nextRoleAssignmentIndex();
    if (grant.role === "Cosmos DB Built-in Data Contributor") {
      if (resource.kind !== "document-database") {
        throw new Error(`Role '${grant.role}' requires a document-database resource.`);
      }
      context.sections.push(
        "",
        `resource contractCosmosRole${index} 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {`,
        `  parent: ${scope}`,
        `  name: guid(${scope}.id, ${principal}, '00000000-0000-0000-0000-000000000002')`,
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
    context.sections.push(
      "",
      `resource contractRole${index} 'Microsoft.Authorization/roleAssignments@2022-04-01' = {`,
      `  name: guid(${scope}.id, ${principal}, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${roleId}'))`,
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

function accessScope(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): string {
  const symbols = context.symbols.get(resource.id)!;
  return resource.kind === "ai-project" ? symbols.project! : symbols.main!;
}

function principalKey(context: BicepRenderContext, output: string): string {
  const producer = context.contract.resources.find((resource) =>
    resource.produces?.includes(output),
  );
  if (!producer) throw new Error(`Principal output '${output}' has no producer.`);
  const symbols = context.symbols.get(producer.id)!;
  if (producer.kind === "container-host") return `${symbols.identity}.id`;
  if (producer.kind === "bot-identity") return `${symbols.main}.id`;
  throw new Error(
    `Principal output '${output}' is produced by unsupported kind '${producer.kind}'.`,
  );
}

function isDeferredPrincipal(
  context: BicepRenderContext,
  output: string,
): boolean {
  const producer = context.contract.resources.find((resource) =>
    resource.produces?.includes(output),
  );
  return producer !== undefined && context.isHostedAgent(producer);
}