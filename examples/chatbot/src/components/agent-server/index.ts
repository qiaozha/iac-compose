import {
  deployAppServiceContainer,
  prepareAppServiceContainer,
  type Deployment,
  waitForHttp,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  agentRoot,
  agentServerProvisioningEntrypoint,
  generatedAgentServerProject,
  generatedRoot,
} from "../../runtime/paths.js";
import { uploadBotConfiguration } from "../shared/configuration.js";

export async function agentServer(deployment: Deployment): Promise<void> {
  const outputs = await deployment.provision("FastAPI agent server infrastructure", {
    entrypoint: agentServerProvisioningEntrypoint,
    outputDirectory: generatedAgentServerProject,
    layer: "agent-server",
    dependsOn: ["shared"],
    deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-agent-server`,
    scope: "resourceGroup",
    resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
  });
  await deployment.deploy(
    "persist agent server outputs and upload bot configuration",
    async () => {
      await persistEnvironment(deployment, outputs);
      await uploadBotConfiguration(deployment);
    },
  );

  if (deployment.dryRun) {
    await prepareAppServiceContainer(
      deployment,
      agentServerService(),
    );
  }

  await deployment.deploy("FastAPI agent server", async () => {
    const service = agentServerService();
    const values = await deployAppServiceContainer(deployment, service);
    const image = requiredEnv("SERVICE_AGENT_SERVER_IMAGE_NAME", values);
    const siteName = requiredEnv("AGENT_SERVER_SITE_NAME");
    await waitForHttp(`${requiredEnv("SERVER_BASE_URL").replace(/\/+$/, "")}/ping`, {
      attempts: 18,
      delayMs: 10_000,
    });
    await persistEnvironment(deployment, {
      SERVICE_AGENT_SERVER_IMAGE_NAME: image,
      SERVICE_AGENT_SERVER_NAME: siteName,
    });
  });
}

function agentServerService() {
  return {
    directory: generatedRoot,
    service: "agent-server",
    resourceName:
      process.env.AGENT_SERVER_SITE_NAME?.trim() ||
      "${AGENT_SERVER_SITE_NAME}",
    project: agentRoot,
    dockerfile: "Dockerfile",
    context: ".",
    imageName: "azure-sdk-qa-bot-agent-server",
    tag: process.env.AGENT_SERVER_IMAGE_TAG?.trim(),
    remoteBuild: true,
  } as const;
}