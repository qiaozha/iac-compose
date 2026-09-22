import type { Deployment } from "iac-compose";

export async function api(deployment: Deployment): Promise<void> {
  await deployment.deploy("api application", async () => {});
}
