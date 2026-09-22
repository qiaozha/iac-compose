import type { Deployment } from "iac-compose";

export async function prepareEnvironment(
  deployment: Deployment,
): Promise<void> {
  await deployment.env("prepare environment", {
    AZURE_ENV_NAME: deployment.environment ?? "dev",
  });
}
