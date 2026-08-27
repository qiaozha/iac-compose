import { resolve } from "node:path";

import {
  getAzdProject,
  readEnvironmentFile,
  requiredEnv,
  resolveAzureSubscriptionContext,
  stringEnvironment,
  type Deployment,
  type EnvironmentValues,
} from "imperative-deploy";
import { environmentRoot, generatedRoot } from "./paths.js";

export { requiredEnv, type EnvironmentValues };

export async function prepareEnvironment(deployment: Deployment): Promise<void> {
  const name = deployment.environment ?? process.env.AZURE_ENV_NAME ?? "dev";
  const shellValues = stringEnvironment(process.env);
  const configuredValues = await readEnvironmentFile(
    resolve(environmentRoot, `${name}.json`),
  );
  const persistedValues = deployment.dryRun
    ? {}
    : await environmentProject(deployment, name).getValues();
  Object.assign(process.env, configuredValues, persistedValues, shellValues, {
    AZURE_ENV_NAME: name,
  });
  process.env.AZURE_LOCATION ??= "westus2";
  if (deployment.dryRun) {
    await environmentProject(deployment, name).initialize();
  }

  await deployment.deploy("resolve Azure account context", async () => {
    const account = await resolveAzureSubscriptionContext(deployment, {
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      tenantId: process.env.AZURE_TENANT_ID,
    });
    process.env.AZURE_SUBSCRIPTION_ID = account.subscriptionId;
    process.env.AZURE_TENANT_ID = account.tenantId;
    await persistEnvironment(deployment, {
      AZURE_SUBSCRIPTION_ID: account.subscriptionId,
      AZURE_TENANT_ID: account.tenantId,
      AZURE_LOCATION: requiredEnv("AZURE_LOCATION"),
    });
  });
  if (deployment.dryRun) {
    process.env.AZURE_SUBSCRIPTION_ID ??= "00000000-0000-0000-0000-000000000000";
    process.env.AZURE_TENANT_ID ??= "00000000-0000-0000-0000-000000000000";
  }
}

export async function persistEnvironment(
  deployment: Deployment,
  values: EnvironmentValues,
): Promise<void> {
  await environmentProject(deployment).setValues(values);
}

function environmentProject(deployment: Deployment, environment?: string) {
  return getAzdProject(deployment, {
    directory: generatedRoot,
    environment,
    mergeManifest: true,
    manifest: {
      name: "imperative-deploy-contoso-support",
      requiredVersions: { azd: ">= 1.30.0" },
    },
  });
}
