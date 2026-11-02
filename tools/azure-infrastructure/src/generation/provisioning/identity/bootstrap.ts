import type { ProvisioningSourceOptions } from "../types.js";
import { entraApplicationPlans, entraOutput } from "./planning.js";

export function renderEntraIdentityBootstrapSource(
  options: ProvisioningSourceOptions,
): string {
  const plans = entraApplicationPlans(options);
  if (plans.length === 0) return "";
  const declarations = plans.map((plan) => `const ${plan.base}ApplicationUniqueName = stack.parameters.add(
  ${JSON.stringify(`${plan.base}ApplicationUniqueName`)},
  "string",
);
const ${plan.base}ApplicationAppId = bicepRef<string>(${JSON.stringify(`${plan.base}Application.appId`)});
const ${plan.base}ApplicationObjectId = bicepRef<string>(${JSON.stringify(`${plan.base}Application.id`)});
const ${plan.base}ServicePrincipalId = bicepRef<string>(${JSON.stringify(`${plan.base}ServicePrincipal.id`)});

stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_APP_ID"))}, "string", ${plan.base}ApplicationAppId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_OBJECT_ID"))}, "string", ${plan.base}ApplicationObjectId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "SERVICE_PRINCIPAL_ID"))}, "string", ${plan.base}ServicePrincipalId);
stack.outputs.add(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_UNIQUE_NAME"))}, "string", ${plan.base}ApplicationUniqueName);`).join("\n\n");
  const resources = plans.map((plan) => `  {
    identifier: ${JSON.stringify(`${plan.base}Application`)},
    type: "Microsoft.Graph/applications",
    body: {
      uniqueName: ${plan.base}ApplicationUniqueName,
      displayName: ${JSON.stringify(plan.displayName)},
      signInAudience: "AzureADMyOrg",
      serviceManagementReference: ${JSON.stringify(options.serviceManagementReference)},
    },
  },
  {
    identifier: ${JSON.stringify(`${plan.base}ServicePrincipal`)},
    type: "Microsoft.Graph/servicePrincipals",
    body: { appId: ${plan.base}ApplicationAppId },
  },`).join("\n");
  const bindings = plans.map((plan) =>
    `    ${plan.base}ApplicationUniqueName: fn.readEnvironmentVariable(${JSON.stringify(entraOutput(plan.resource.id, "APPLICATION_UNIQUE_NAME"))}),`
  ).join("\n");
  return `import {
  bicepRef,
  createBicepParameterFile,
  renderBicepParameterFile,
} from "@azure/provisioning-bicep";
import { fn, Stack } from "@azure/provisioning-core";

import { renderGraphStack } from "./graph-provisioning.js";

const stack = new Stack("main", { targetScope: "subscription" });
${declarations}

const rendered = renderGraphStack(stack, [
${resources}
]);
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
${bindings}
  },
});

export const outputJson = rendered.outputJson;
export const outputBicep = [
  { ...rendered.main, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];
`;
}