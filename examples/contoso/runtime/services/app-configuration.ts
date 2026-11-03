import type { Deployment } from "iac-composer";

export interface AppConfigurationKeyValuesOptions {
  subscriptionId: string;
  storeName: string;
  values: Readonly<Record<string, string>>;
}

export async function setAppConfigurationKeyValues(
  deployment: Deployment,
  options: AppConfigurationKeyValuesOptions,
): Promise<void> {
  if (deployment.dryRun) return;
  for (const [key, value] of Object.entries(options.values)) {
    await deployment.execute({
      command: "az",
      args: [
        "appconfig",
        "kv",
        "set",
        "--subscription",
        options.subscriptionId,
        "--name",
        options.storeName,
        "--auth-mode",
        "login",
        "--key",
        key,
        "--value",
        value,
        "--yes",
        "--output",
        "none",
      ],
    });
  }
}
