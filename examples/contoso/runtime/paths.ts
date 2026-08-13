import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const deploymentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packageRoot = resolve(deploymentRoot, "../../../FoundryChatbot/support-agent-template/artifacts/contoso-support/package");
export const generatedRoot = resolve(deploymentRoot, ".generated");
export const stateRoot = resolve(deploymentRoot, ".state");
export const environmentRoot = resolve(deploymentRoot, "environments");
export const generatedSharedProject = resolve(generatedRoot, "shared");
export const generatedAgentProject = resolve(generatedRoot, "agent");
export const generatedBackendProject = resolve(generatedRoot, "backend");
export const generatedFrontendProject = resolve(generatedRoot, "frontend");
export const generatedLogicAppProject = resolve(generatedRoot, "logic-app");
export const sharedProvisioningEntrypoint = resolve(
  deploymentRoot,
  "components/shared/provisioning.ts",
);
export const agentProvisioningEntrypoint = resolve(
  deploymentRoot,
  "components/agent/provisioning.ts",
);
export const backendProvisioningEntrypoint = resolve(
  deploymentRoot,
  "components/backend/provisioning.ts",
);
export const frontendProvisioningEntrypoint = resolve(
  deploymentRoot,
  "components/frontend/provisioning.ts",
);
export const logicAppProvisioningEntrypoint = resolve(
  deploymentRoot,
  "components/logic-app/provisioning.ts",
);
export const generatedIdentityProject = resolve(generatedRoot, "identity");
export const identityBootstrapEntrypoint = resolve(
  deploymentRoot,
  "components/shared/identity-bootstrap.ts",
);
export const identityConfigurationEntrypoint = resolve(
  deploymentRoot,
  "components/shared/identity-configuration.ts",
);
