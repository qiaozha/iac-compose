import type { Deployment } from "iac-compose";

export async function shared(deployment: Deployment): Promise<void> {
  await deployment.deploy("shared resources", async () => {});
}
