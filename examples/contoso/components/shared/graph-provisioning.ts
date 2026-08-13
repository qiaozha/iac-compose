import { renderBicepFile, type RenderedBicepFile } from "@azure/provisioning-bicep";
import { type ExpressionOrValue, type Stack } from "@azure/provisioning-core";
import {
  serialize,
  serializeExpression,
  type SerializableValue,
} from "@azure/provisioning-serialization";
import type {
  ResourceDeclarationNode,
  SerializationDocument,
} from "@azure/provisioning-serialization-ast";

const graphExtension =
  "br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:1.0.0";

export interface GraphResourceDefinition {
  readonly identifier: string;
  readonly type: string;
  readonly body: Readonly<Record<string, SerializableValue>>;
  readonly condition?: ExpressionOrValue<boolean>;
}

export interface RenderedGraphStack {
  readonly outputJson: SerializationDocument;
  readonly main: RenderedBicepFile;
}

export function renderGraphStack(
  stack: Stack,
  resources: readonly GraphResourceDefinition[],
): RenderedGraphStack {
  const serialized = serialize([stack]);
  const [infra] = serialized.infras;
  if (infra === undefined) {
    throw new Error("Graph provisioning produced no infrastructure entry.");
  }
  const graphResources = Object.fromEntries(
    resources.map((resource) => [resource.identifier, createGraphResource(resource)]),
  );
  const graphInfra = {
    ...infra,
    resources: { ...infra.resources, ...graphResources },
    extensions: [...(infra.extensions ?? []), { path: graphExtension }],
  };
  const outputJson: SerializationDocument = { infras: [graphInfra] };
  return { outputJson, main: renderBicepFile(graphInfra) };
}

function createGraphResource(
  resource: GraphResourceDefinition,
): ResourceDeclarationNode {
  const body = serializeExpression(resource.body);
  if (body.kind !== "object") {
    throw new Error(`Graph resource '${resource.identifier}' must be an object.`);
  }
  return {
    bicepIdentifier: resource.identifier,
    type: resource.type,
    apiVersion: "v1.0",
    existing: false,
    value:
      resource.condition === undefined
        ? body
        : {
            kind: "if-condition",
            condition: serializeExpression(resource.condition),
            body,
          },
  };
}
