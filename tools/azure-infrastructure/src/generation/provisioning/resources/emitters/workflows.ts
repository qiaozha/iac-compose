import {
  hyphenatedPrefix,
  identifier,
  typescriptProperty,
} from "../../names.js";
import { implementationOutput } from "../../outputs.js";
import { asObject } from "../../values.js";
import { collectWorkflowInputs } from "../../workflows.js";
import type { RenderingContext } from "../context.js";

export function renderWorkflows(context: RenderingContext): void {
  for (const plan of context.workflowPlans) {
    const base = identifier(plan.resource.id);
    const parameterValues = asObject(asObject(plan.resource.parameters).parameters);
    const identities = asObject(asObject(parameterValues.userAssignedIdentities).value);
    const identityExpressions = Object.keys(identities).map((key) => context.renderValue(key));
    const identity =
      identityExpressions.length === 0
        ? "undefined"
        : identityExpressions
            .map((expression) => `fn.json(fn.concat('{"', ${expression}, '":{}}'))`)
            .reduce((left, right) => `fn.union(${left}, ${right})`);
    const identityType =
      identityExpressions.length === 0
        ? "SystemAssigned"
        : plan.resource.identity === "user-assigned"
          ? "UserAssigned"
          : "SystemAssigned,UserAssigned";
    const teamsConnectionId = context.outputs.get("teamsConnectionResourceId") ??
      `fn.resourceId("Microsoft.Web/connections", "teams")`;
    const connectionResource = context.ofKind("authorized-api-connection")[0];
    const managedApiId = connectionResource
      ? `${identifier(connectionResource.id)}ManagedApiId`
      : `fn.concat("/subscriptions/", fn.subscription().subscriptionId, "/providers/Microsoft.Web/locations/", location, "/managedApis/teams")`;
    const inputNames = collectWorkflowInputs(plan.definition);
    const inputLines = inputNames
      .map((name) => {
        const expression = plan.parameterExpressions.get(name);
        if (!expression) {
          throw new Error(
            `Workflow '${plan.resource.id}' has no expression for parameter '${name}'.`,
          );
        }
        return `    ${typescriptProperty(name)}: ${expression},`;
      })
      .join("\n");
    context.addSection(`const ${base}Name = fn.concat(
  ${JSON.stringify(hyphenatedPrefix(context.solutionName(), plan.resource.id, 62))},
  suffix,
);

const ${base} = new Workflow(stack, {
  name: ${base}Name,
  location,
  identity: {
    type: ${JSON.stringify(identityType)},
    ${identityExpressions.length > 0 ? `userAssignedIdentities: ${identity} as any,` : ""}
  },
  properties: {
    state: "Disabled",
    definition: ${plan.functionName}({
${inputLines}
    }) as any,
    parameters: {
      $connections: {
        value: {
          teams: {
            connectionId: ${teamsConnectionId},
            connectionName: "teams",
            connectionProperties: {},
            id: ${managedApiId},
          },
        },
      },
    },
  } as any,
},
${plan.deploymentCondition ? `  { condition: ${plan.deploymentCondition} },` : ""}
);
`);
    context.outputs.set(implementationOutput(plan.resource.id, "NAME"), `${base}Name`);
  }
}