import {
  bicepRef,
  createBicepParameterFile,
  renderBicepParameterFile,
} from "@azure/provisioning-bicep";
import { fn, Stack } from "@azure/provisioning-core";

import { renderGraphStack } from "./graph-provisioning.js";

const stack = new Stack("main", { targetScope: "subscription" });
const environmentName = stack.parameters.add("environmentName", "string");
const applicationUniqueName = stack.parameters.add(
  "applicationUniqueName",
  "string",
  { defaultValue: "" },
);
const serviceManagementReference = stack.parameters.add(
  "serviceManagementReference",
  "string",
  { defaultValue: "" },
);
const applicationName = stack.variables.add(
  "applicationName",
  fn.concat("azuresdkqabot-server-", environmentName),
);
const effectiveApplicationUniqueName = stack.variables.add(
  "effectiveApplicationUniqueName",
  fn.cond(
    fn.not(fn.empty(applicationUniqueName)),
    applicationUniqueName,
    applicationName,
  ),
);

const serverApplicationAppId = bicepRef<string>("serverApplication.appId");
const serverApplicationId = bicepRef<string>("serverApplication.id");
const serverServicePrincipalId = bicepRef<string>("serverServicePrincipal.id");

stack.outputs.add("SERVER_AUDIENCE", "string", serverApplicationAppId);
stack.outputs.add(
  "SERVER_APPLICATION_UNIQUE_NAME",
  "string",
  effectiveApplicationUniqueName,
);
stack.outputs.add(
  "SERVER_APPLICATION_OBJECT_ID",
  "string",
  serverApplicationId,
);
stack.outputs.add(
  "SERVER_SERVICE_PRINCIPAL_ID",
  "string",
  serverServicePrincipalId,
);
stack.outputs.add(
  "RAG_SERVICE_SCOPE",
  "string",
  fn.concat("api://", serverApplicationAppId, "/.default"),
);

const rendered = renderGraphStack(stack, [
  {
    identifier: "serverApplication",
    type: "Microsoft.Graph/applications",
    body: {
      uniqueName: effectiveApplicationUniqueName,
      displayName: applicationName,
      signInAudience: "AzureADMyOrg",
      serviceManagementReference: fn.cond<string | null>(
        fn.not(fn.empty(serviceManagementReference)),
        serviceManagementReference,
        null,
      ),
    },
  },
  {
    identifier: "serverServicePrincipal",
    type: "Microsoft.Graph/servicePrincipals",
    body: { appId: serverApplicationAppId },
  },
]);

const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    environmentName: fn.readEnvironmentVariable("AZURE_ENV_NAME"),
    applicationUniqueName: fn.readEnvironmentVariable(
      "SERVER_APPLICATION_UNIQUE_NAME",
      "",
    ),
    serviceManagementReference: fn.readEnvironmentVariable(
      "SERVICE_MANAGEMENT_REFERENCE",
      "",
    ),
  },
});

export const outputJson = rendered.outputJson;
export const outputBicep = [
  { ...rendered.main, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];