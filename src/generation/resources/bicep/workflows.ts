import type { ResourceContractRequirement } from "../../../shared/contracts/resources/types.js";
import type { BicepRenderContext } from "./context.js";
import {
  asObject,
  azureName,
  bicepProperty,
  resourceOutputName,
  safeFileName,
} from "./syntax.js";

export function renderAuthorizedConnection(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  const symbols = context.symbols.get(resource.id)!;
  context.sections.push(
    "",
    `resource ${symbols.main} 'Microsoft.Web/connections@2016-06-01' = if (${context.connectionCreateParameter(resource)}) {`,
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
  context.implementationOutputs.set(
    resourceOutputName(resource.id, "NAME"),
    "'teams'",
  );
}

export function renderWorkflow(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  const symbols = context.symbols.get(resource.id)!;
  const template = asObject(context.options.templates?.[resource.id]);
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
  context.sections.push(
    "",
    `module ${symbols.main} './templates/${safeFileName(resource.id)}.json' = {`,
    `  name: ${azureName(context.contract.solution.name, `${resource.id}-deployment`, 64, true)}`,
    "  params: {",
    ...Object.entries(parameters).map(([name, parameter]) => {
      const value = asObject(parameter).value;
      return `    ${bicepProperty(name)}: ${context.renderParameterValue(value)}`;
    }),
    "  }",
    "}",
  );
  context.implementationOutputs.set(
    resourceOutputName(resource.id, "NAME"),
    symbols.workflowName!,
  );
}