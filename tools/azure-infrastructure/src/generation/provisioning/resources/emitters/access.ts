import { identifier } from "../../names.js";
import { implementationOutput } from "../../outputs.js";
import { resourceOwner } from "../../ownership.js";
import { asObject } from "../../values.js";
import type { RenderingContext } from "../context.js";
import { accessValues } from "../helpers.js";

const roleIds: Readonly<Record<string, string>> = {
  AcrPull: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  "App Configuration Data Reader": "516239f1-63e1-4d78-a4de-a74fb236a071",
  "Azure AI User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Foundry User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Storage Blob Data Contributor": "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
};

export function renderConfigurationValues(context: RenderingContext): void {
  for (const resource of context.resources.filter(
    (candidate) => candidate.kind === "configuration-store",
  )) {
    const base = identifier(resource.id);
    const values = asObject(asObject(resource.configuration).values);
    const ownedValues = Object.entries(values).filter(
      ([, value]) => context.configurationValueOwner(value) === context.effectiveOwner(),
    );
    if (ownedValues.length === 0) continue;
    if (!context.owns(resource)) context.ensureExistingResource(resource);
    for (const [name, value] of ownedValues) {
      context.addSection(`new KeyValue(${base}Store, {
  name: ${JSON.stringify(name)},
  properties: {
    value: ${context.renderValue(value)},
  },
});
`);
    }
  }
}

export function renderAccess(context: RenderingContext): void {
  for (const resource of context.resources) {
    for (const grant of accessValues(resource)) {
      const producer = context.resources.find((candidate) =>
        candidate.produces?.includes(grant.principalOutput),
      );
      if (!producer) {
        throw new Error(
          `Resource '${resource.id}' references unknown principal '${grant.principalOutput}'.`,
        );
      }
      if (context.isHosted(producer)) {
        if (context.owns(resource)) {
          const scope = context.scopeExpression(resource);
          context.outputs.set(
            implementationOutput(resource.id, "ACCESS_SCOPE"),
            `${scope}.id`,
          );
        }
        continue;
      }
      if (
        context.owner !== undefined &&
        resourceOwner(producer) !== context.owner
      ) {
        continue;
      }
      const scope = context.scopeExpression(resource);
      const principalId = context.outputs.get(grant.principalOutput);
      const principalKey = context.principalKey(producer);
      if (!principalId) {
        throw new Error(`Principal output '${grant.principalOutput}' is unavailable.`);
      }
      if (grant.role === "Cosmos DB Built-in Data Contributor") {
        const base = identifier(resource.id);
        context.addSection(`new SqlRoleAssignment(${base}Account, {
  name: fn.guid(
    ${base}Account.id,
    ${principalKey},
    "00000000-0000-0000-0000-000000000002",
  ),
  properties: {
    roleDefinitionId: fn.concat(
      ${base}Account.id,
      "/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002",
    ) as any,
    principalId: ${principalId} as any,
    scope: ${base}Account.id as any,
  },
});
`);
        continue;
      }
      const roleId = roleIds[grant.role];
      if (!roleId) throw new Error(`Unsupported Azure role '${grant.role}'.`);
      context.addSection(`new RoleAssignment(${scope}, {
  name: fn.guid(
    ${scope}.id,
    ${principalKey},
    fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      ${JSON.stringify(roleId)},
    ),
  ),
  properties: {
    roleDefinitionId: fn.subscriptionResourceId(
      "Microsoft.Authorization/roleDefinitions",
      ${JSON.stringify(roleId)},
    ),
    principalId: ${principalId} as any,
    principalType: "ServicePrincipal",
  },
});
`);
    }
  }
}