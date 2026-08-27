import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProvisioningLayer } from "imperative-deploy";

export const deploymentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packageRoot = resolve(deploymentRoot, "../../../FoundryChatbot/support-agent-template/artifacts/contoso-support/package");
export const generatedRoot = resolve(deploymentRoot, ".generated");
export const environmentRoot = resolve(deploymentRoot, "environments");
export const generatedSharedLayer = provisioningLayer("shared");
export const generatedAgentLayer = provisioningLayer("agent");
export const generatedBackendLayer = provisioningLayer("backend");
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

function provisioningLayer(
  name: string,
  entrypoint = `components/${name}/provisioning.ts`,
): ProvisioningLayer {
  return {
    entrypoint: resolve(deploymentRoot, entrypoint),
    outputDirectory: resolve(generatedRoot, name),
  };
}
