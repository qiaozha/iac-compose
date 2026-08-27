import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProvisioningLayer } from "imperative-deploy";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const exampleRoot = resolve(sourceRoot, "..");
export const chatbotRoot = resolve(
  exampleRoot,
  "../../../azure-sdk-tools/tools/sdk-ai-bots",
);
export const generatedRoot = resolve(exampleRoot, ".generated");
export const generatedSharedLayer = provisioningLayer("shared");
export const generatedAgentLayer = provisioningLayer("agent");
export const generatedAgentServerLayer = provisioningLayer("agent-server");
export const generatedFunctionAppLayer = provisioningLayer("function-app");
export const generatedFrontendLayer = provisioningLayer("frontend");
export const generatedLogicAppLayer = provisioningLayer("logic-app");
export const generatedIdentityBootstrapLayer = provisioningLayer(
  "identity",
  "components/shared/identity-bootstrap.ts",
);
export const generatedIdentityConfigurationLayer = provisioningLayer(
  "identity",
  "components/shared/identity-configuration.ts",
);
export const environmentRoot = resolve(sourceRoot, "environments");
export const botConfigRoot = resolve(sourceRoot, "components/shared/config");

export const agentRoot = resolve(chatbotRoot, "azure-sdk-qa-bot-agent");
export const functionAppRoot = resolve(chatbotRoot, "azure-sdk-qa-bot-function");
export const frontendRoot = resolve(chatbotRoot, "azure-sdk-qa-bot");

function provisioningLayer(
  name: string,
  entrypoint = `components/${name}/provisioning.ts`,
): ProvisioningLayer {
  return {
    entrypoint: resolve(sourceRoot, entrypoint),
    outputDirectory: resolve(generatedRoot, name),
  };
}