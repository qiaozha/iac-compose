import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const exampleRoot = resolve(sourceRoot, "..");
export const chatbotRoot = resolve(
  exampleRoot,
  "../../../azure-sdk-tools/tools/sdk-ai-bots",
);
export const sharedProvisioningEntrypoint = resolve(
  sourceRoot,
  "components/shared/provisioning.ts",
);
export const agentProvisioningEntrypoint = resolve(
  sourceRoot,
  "components/agent/provisioning.ts",
);
export const frontendProvisioningEntrypoint = resolve(
  sourceRoot,
  "components/frontend/provisioning.ts",
);
export const agentServerProvisioningEntrypoint = resolve(
  sourceRoot,
  "components/agent-server/provisioning.ts",
);
export const functionAppProvisioningEntrypoint = resolve(
  sourceRoot,
  "components/function-app/provisioning.ts",
);
export const generatedSharedProject = resolve(exampleRoot, ".generated/shared");
export const generatedAgentProject = resolve(exampleRoot, ".generated/agent");
export const generatedAgentServerProject = resolve(
  exampleRoot,
  ".generated/agent-server",
);
export const generatedFunctionAppProject = resolve(
  exampleRoot,
  ".generated/function-app",
);
export const generatedFrontendProject = resolve(
  exampleRoot,
  ".generated/frontend",
);
export const generatedIdentityProject = resolve(
  exampleRoot,
  ".generated/identity",
);
export const generatedLogicAppProject = resolve(
  exampleRoot,
  ".generated/logic-app",
);
export const logicAppProvisioningEntrypoint = resolve(
  sourceRoot,
  "components/logic-app/provisioning.ts",
);
export const identityBootstrapEntrypoint = resolve(
  sourceRoot,
  "components/shared/identity-bootstrap.ts",
);
export const identityConfigurationEntrypoint = resolve(
  sourceRoot,
  "components/shared/identity-configuration.ts",
);
export const stateRoot = resolve(exampleRoot, ".state");
export const environmentRoot = resolve(sourceRoot, "environments");
export const botConfigRoot = resolve(sourceRoot, "components/shared/config");

export const agentRoot = resolve(chatbotRoot, "azure-sdk-qa-bot-agent");
export const functionAppRoot = resolve(chatbotRoot, "azure-sdk-qa-bot-function");
export const frontendRoot = resolve(chatbotRoot, "azure-sdk-qa-bot");