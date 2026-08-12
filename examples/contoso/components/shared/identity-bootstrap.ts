import {
  bicepRef,
  createBicepParameterFile,
  renderBicepFile,
} from "@azure/provisioning-bicep";
import { fn, Stack } from "@azure/provisioning-core";

import { renderGraphStack } from "./graph-provisioning.js";

const stack = new Stack("main", { targetScope: "subscription" });
const backendComputeApplicationUniqueName = stack.parameters.add(
  "backendComputeApplicationUniqueName",
  "string",
);
const backendComputeApplicationAppId = bicepRef<string>("backendComputeApplication.appId");
const backendComputeApplicationObjectId = bicepRef<string>("backendComputeApplication.id");
const backendComputeServicePrincipalId = bicepRef<string>("backendComputeServicePrincipal.id");

stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_APP_ID", "string", backendComputeApplicationAppId);
stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_OBJECT_ID", "string", backendComputeApplicationObjectId);
stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_SERVICE_PRINCIPAL_ID", "string", backendComputeServicePrincipalId);
stack.outputs.add("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_UNIQUE_NAME", "string", backendComputeApplicationUniqueName);

const rendered = renderGraphStack(stack, [
  {
    identifier: "backendComputeApplication",
    type: "Microsoft.Graph/applications",
    body: {
      uniqueName: backendComputeApplicationUniqueName,
      displayName: "contoso-support backendCompute API",
      signInAudience: "AzureADMyOrg",
      serviceManagementReference: "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4",
    },
  },
  {
    identifier: "backendComputeServicePrincipal",
    type: "Microsoft.Graph/servicePrincipals",
    body: { appId: backendComputeApplicationAppId },
  },
]);
const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    backendComputeApplicationUniqueName: fn.readEnvironmentVariable("DEPLOY_ENTRA_BACKENDCOMPUTE_APPLICATION_UNIQUE_NAME"),
  },
});

export const outputJson = rendered.outputJson;
export const outputBicep = [
  { ...rendered.main, path: "main.bicep" },
  renderBicepFile(parameterFile),
];
