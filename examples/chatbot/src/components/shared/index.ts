import {
  ensureResourceGroup,
  type Deployment,
  type ProvisionOutputs,
} from "imperative-deploy";
import { persistEnvironment, requiredEnv } from "../../runtime/environment.js";
import { ensureServerApplication } from "./identity.js";
import {
  generatedSharedProject,
  sharedProvisioningEntrypoint,
} from "../../runtime/paths.js";

export async function shared(deployment: Deployment): Promise<void> {
  validateEnvironment();
  const environment = requiredEnv("AZURE_ENV_NAME");
  const resourceGroup =
    process.env.AZURE_RESOURCE_GROUP?.trim() ||
    `rg-azuresdkqabot-${environment}`;
  process.env.AZURE_RESOURCE_GROUP = resourceGroup;
  await deployment.deploy("ensure chatbot resource group", async () => {
    await ensureResourceGroup(deployment, {
      name: resourceGroup,
      location: requiredEnv("AZURE_LOCATION"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
    await persistEnvironment(deployment, {
      AZURE_RESOURCE_GROUP: resourceGroup,
    });
  });
  if (deployment.dryRun) {
    await ensureServerApplication(deployment);
  }
  await deployment.deploy("prepare shared resource inputs", async () => {
    await ensureServerApplication(deployment);
  });

  const outputs = await deployment.provision("shared chatbot infrastructure", {
    entrypoint: sharedProvisioningEntrypoint,
    outputDirectory: generatedSharedProject,
    layer: "shared",
    dependsOn: ["identity"],
    deploymentName: `${environment}-shared`,
    scope: "resourceGroup",
    resourceGroup,
    location: requiredEnv("AZURE_LOCATION"),
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
  });

  await deployment.deploy("persist shared resource outputs", async () => {
    await persistEnvironment(
      deployment,
      normalizeOutputs(outputs),
    );
  });
}

function validateEnvironment(): void {
  const environment = requiredEnv("AZURE_ENV_NAME");
  if (!["dev", "preview", "prod"].includes(environment)) {
    throw new Error(`Unsupported chatbot environment '${environment}'.`);
  }
  if (
    environment === "prod" &&
    !process.env.TF_BUILD &&
    !process.env.GITHUB_ACTIONS
  ) {
    throw new Error("Production provisioning is restricted to CI/CD.");
  }
}

function normalizeOutputs(outputs: ProvisionOutputs): ProvisionOutputs {
  const registry =
    outputs.CONTAINER_REGISTRY_LOGIN_SERVER ||
    (outputs.CONTAINER_REGISTRY_NAME
      ? `${outputs.CONTAINER_REGISTRY_NAME}.azurecr.io`
      : "");
  return {
    ...outputs,
    ...(registry ? { AZURE_CONTAINER_REGISTRY_ENDPOINT: registry } : {}),
  };
}