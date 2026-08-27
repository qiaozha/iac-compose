import {
  ensureDeploymentPrincipalRoles,
  ensureResourceGroup,
  type Deployment,
} from "imperative-deploy";
import { persistEnvironment, requiredEnv } from "../../runtime/environment.js";
import {
  generatedSharedLayer,
} from "../../runtime/paths.js";
import { solutionName } from "./provisioning.js";
import { ensureEntraApplications } from "./identity.js";

export async function shared(deployment: Deployment): Promise<void> {
  const environment = requiredEnv("AZURE_ENV_NAME");
  const resourceGroup =
    process.env.AZURE_RESOURCE_GROUP?.trim() ||
    `rg-${solutionName}-${environment}`;
  process.env.AZURE_RESOURCE_GROUP = resourceGroup;
  await deployment.deploy("ensure deployment resource group", async () => {
    await ensureResourceGroup(deployment, {
      name: resourceGroup,
      location: requiredEnv("AZURE_LOCATION"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
  await deployment.deploy("grant deployment data-plane roles", async () => {
    await ensureDeploymentPrincipalRoles(deployment, {
      subscriptionId: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      tenantId: process.env.AZURE_TENANT_ID,
      principalId: process.env.AZURE_PRINCIPAL_ID,
      principalType: process.env.AZURE_PRINCIPAL_TYPE,
      scope: `/subscriptions/${requiredEnv("AZURE_SUBSCRIPTION_ID")}/resourceGroups/${resourceGroup}`,
      roles: [
            {"provider":"Microsoft.AppConfiguration","role":"App Configuration Data Owner","roleDefinitionId":"5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b","reason":"write generated application settings"},
        {"provider":"Microsoft.ContainerRegistry","role":"AcrPush","roleDefinitionId":"8311e382-0749-4cb8-b61a-304f252e45ec","reason":"publish generated component images"},
        {"provider":"Microsoft.CognitiveServices","role":"Foundry User","roleDefinitionId":"53ca6127-db72-4b80-b1b0-d745d6d5456d","reason":"deploy the hosted Foundry agent"},
      ],
    });
  });
  const outputs = await deployment.provision("solution infrastructure", {
    layer: generatedSharedLayer,
    deploymentName: `${environment}-${solutionName}`,
    scope: "resourceGroup",
    resourceGroup,
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
  });
  await deployment.deploy("persist solution infrastructure", async () => {
    await persistEnvironment(deployment, outputs);
  });
  await ensureEntraApplications(deployment);
}
