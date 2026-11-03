import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineDeployment } from "iac-composer";

const root = dirname(fileURLToPath(import.meta.url));
const subscription = "9dbc8298-39f2-4fca-bbec-e8af850c1bc0";
const resourceGroup = "cs336";
const location = "westus2";

export default defineDeployment(async (deployment) => {
  if (deployment.component && deployment.component !== "foundry") {
    throw new Error(
      `Unknown Foundry component '${deployment.component}'. Expected: foundry.`,
    );
  }

  await deployment.run("verify existing cs336 resource group", {
    command: "az",
    args: [
      "group", "show",
      "--subscription", subscription,
      "--name", resourceGroup,
      "--query", "id",
      "--output", "tsv",
    ],
  });

  let deploymentPrincipalType: "User" | "ServicePrincipal" | undefined;
  await deployment.deploy("resolve deployment principal type", async () => {
    const accountType = (await deployment.capture({
      command: "az",
      args: [
        "account", "show",
        "--subscription", subscription,
        "--query", "user.type",
        "--output", "tsv",
      ],
    })).trim();
    if (accountType === "user") {
      deploymentPrincipalType = "User";
    } else if (accountType === "servicePrincipal") {
      deploymentPrincipalType = "ServicePrincipal";
    } else {
      throw new Error(`Unsupported deployment identity type '${accountType}'. Expected user or servicePrincipal.`);
    }
  });

  const outputs = await deployment.provision("Foundry resources and deployment identity access", {
    layer: {
      entrypoint: resolve(root, "infra.ts"),
      outputDirectory: resolve(root, ".generated/foundry"),
    },
    deploymentName: `${deployment.environment ?? "cs336"}-foundry`,
    scope: "resourceGroup",
    subscription,
    resourceGroup,
    location,
    parameters: { location },
    environmentValues: { AZURE_PRINCIPAL_TYPE: deploymentPrincipalType },
  });

  if (!deployment.dryRun) {
    for (const name of [
      "AZURE_AI_ACCOUNT_ID",
      "AZURE_AI_ACCOUNT_NAME",
      "AZURE_AI_PROJECT_ID",
      "AZURE_AI_PROJECT_NAME",
      "AZURE_AI_PROJECT_ENDPOINT",
      "AZURE_AI_MODEL_DEPLOYMENT_ID",
      "AZURE_AI_MODEL_DEPLOYMENT_NAME",
      "AZURE_FOUNDRY_ROLE_ASSIGNMENT_ID",
      "AZURE_FOUNDRY_PRINCIPAL_ID",
    ]) {
      if (!outputs[name]?.trim()) {
        throw new Error(`Foundry provisioning did not return required output '${name}'.`);
      }
    }
  }

  await deployment.env("publish Foundry outputs", outputs);
});
