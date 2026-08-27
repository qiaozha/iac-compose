import {
  captureAzure,
  deployAppServiceContainer,
  prepareAppServiceContainer,
  type Deployment,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  functionAppRoot,
  generatedFunctionAppLayer,
  generatedRoot,
} from "../../runtime/paths.js";

export async function functionApp(deployment: Deployment): Promise<void> {
  const outputs = await deployment.provision("Function App infrastructure", {
    layer: generatedFunctionAppLayer,
    deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-function-app`,
    scope: "resourceGroup",
    resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
  });
  await deployment.deploy("persist Function App infrastructure", async () => {
    await persistEnvironment(deployment, outputs);
  });

  if (deployment.dryRun) {
    await prepareAppServiceContainer(
      deployment,
      functionService(),
    );
  }

  await deployment.deploy("Function App container", async () => {
    const service = functionService();
    const values = await deployAppServiceContainer(deployment, service);
    const image = requiredEnv("SERVICE_FUNCTION_APP_IMAGE_NAME", values);
    const name = requiredEnv("FUNCTION_APP_NAME");
    const resourceGroup = requiredEnv("AZURE_RESOURCE_GROUP");
    const state = (
      await captureAzure(deployment, [
        "functionapp",
        "show",
        "--name",
        name,
        "--resource-group",
        resourceGroup,
        "--query",
        "state",
        "--output",
        "tsv",
      ])
    ).trim();
    if (state !== "Running") {
      throw new Error(`Function App '${name}' is '${state}', expected 'Running'.`);
    }
    await persistEnvironment(deployment, {
      SERVICE_FUNCTION_APP_IMAGE_NAME: image,
      SERVICE_FUNCTION_APP_NAME: name,
    });
  });
}

function functionService() {
  return {
    directory: generatedRoot,
    service: "function-app",
    host: "function",
    project: functionAppRoot,
    dockerfile: "Dockerfile",
    context: ".",
    imageName: "azure-sdk-qa-bot-function",
    tag: process.env.FUNCTION_IMAGE_TAG?.trim(),
    remoteBuild: true,
  } as const;
}