import { resolve } from "node:path";

import {
  getAzdProject,
  optionalEnv,
  readEnvironmentFile,
  requiredEnv,
  resolveAzureAccountContext,
  stringEnvironment,
  type Deployment,
  type EnvironmentValues,
} from "imperative-deploy";
import { environmentRoot, generatedRoot } from "./paths.js";

export { optionalEnv, requiredEnv, type EnvironmentValues };

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
    const account = await resolveAzureAccountContext(deployment, {
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      tenantId: process.env.AZURE_TENANT_ID,
      principalId: process.env.DEVELOPER_PRINCIPAL_ID,
      principalType: process.env.DEVELOPER_PRINCIPAL_TYPE,
    });
    process.env.AZURE_SUBSCRIPTION_ID = account.subscriptionId;
    process.env.AZURE_TENANT_ID = account.tenantId;
    process.env.DEVELOPER_PRINCIPAL_ID = account.principalId;
    process.env.DEVELOPER_PRINCIPAL_TYPE = account.principalType;
    await persistEnvironment(deployment, {
      AZURE_SUBSCRIPTION_ID: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      AZURE_TENANT_ID: account.tenantId,
      AZURE_LOCATION: requiredEnv("AZURE_LOCATION"),
      DEVELOPER_PRINCIPAL_ID: account.principalId,
      DEVELOPER_PRINCIPAL_TYPE: account.principalType,
    });
  });
  if (deployment.dryRun) {
    process.env.AZURE_SUBSCRIPTION_ID ??= "00000000-0000-0000-0000-000000000000";
    process.env.AZURE_TENANT_ID ??= "00000000-0000-0000-0000-000000000000";
    process.env.DEVELOPER_PRINCIPAL_ID ??= "00000000-0000-0000-0000-000000000000";
    process.env.DEVELOPER_PRINCIPAL_TYPE ??= "User";
    process.env.RAG_SERVICE_SCOPE ??= "api://dry-run/.default";
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
      name: "imperative-deploy-chatbot",
      requiredVersions: { azd: ">= 1.30.0" },
    },
  });
}
