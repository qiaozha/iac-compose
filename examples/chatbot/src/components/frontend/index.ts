import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  deployAppServiceContainer,
  prepareAppServiceContainer,
  type Deployment,
  waitForHttp,
} from "imperative-deploy";
import {
  optionalEnv,
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
  frontendProvisioningEntrypoint,
  frontendRoot,
  generatedFrontendProject,
} from "../../runtime/paths.js";
import { ensureFrontendAccessRestrictions } from "../shared/frontend-access.js";

const teamsEnvironment = "deploy-js";

export async function frontend(deployment: Deployment): Promise<void> {
  const outputs = await deployment.provision("Teams bot frontend infrastructure", {
    entrypoint: frontendProvisioningEntrypoint,
    outputDirectory: generatedFrontendProject,
    deploymentName: `${requiredEnv("AZURE_ENV_NAME")}-frontend`,
    scope: "resourceGroup",
    resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
  });
  await deployment.deploy("persist frontend infrastructure", async () => {
    await persistEnvironment(requiredEnv("AZURE_ENV_NAME"), outputs);
  });
  await deployment.deploy("allow frontend access to agent server", async () => {
    await ensureFrontendAccessRestrictions(deployment);
  });

  if (deployment.dryRun) {
    await prepareAppServiceContainer(
      deployment,
      frontendService(),
    );
  }

  await deployment.deploy("Teams bot frontend", async () => {
    const service = frontendService();
    const values = await deployAppServiceContainer(deployment, service);
    const image = requiredEnv("SERVICE_FRONTEND_IMAGE_NAME", values);
    const siteName = requiredEnv("FRONTEND_SITE_NAME");

    const teamsEnvFile = await writeTeamsEnvironment();
    const teamsInputValues = parseEnvironment(await readFile(teamsEnvFile, "utf8"));
    await deployment.execute({
      command: "npx",
      args: [
        "--yes",
        "@microsoft/teamsapp-cli",
        "provision",
        "--env",
        teamsEnvironment,
        "--interactive",
        "true",
      ],
      cwd: frontendRoot,
      env: {
        CI: "",
        TF_BUILD: "",
        TEAMSFX_INTERACTIVE: "true",
        ...(teamsInputValues.TEAMS_APP_ID
          ? { TEAMS_APP_ID: teamsInputValues.TEAMS_APP_ID }
          : {}),
      },
    });
    const teamsValues = parseEnvironment(await readFile(teamsEnvFile, "utf8"));
    const persisted: Record<string, string> = {
      SERVICE_FRONTEND_IMAGE_NAME: image,
      SERVICE_FRONTEND_NAME: siteName,
    };
    for (const name of [
      "TEAMS_APP_ID",
      "TEAMS_APP_TENANT_ID",
      "TEAMS_APP_PUBLISHED_APP_ID",
    ]) {
      if (teamsValues[name]) persisted[name] = teamsValues[name];
    }
    await persistEnvironment(requiredEnv("AZURE_ENV_NAME"), persisted);

    const healthUrl = `${requiredEnv("BOT_BASE_URL").replace(/\/+$/, "")}/health`;
    await waitForHttp(healthUrl, { attempts: 12, delayMs: 10_000 }).catch((error) => {
      console.warn(`[frontend] ${String(error)}`);
    });
  });
}

function frontendService() {
  return {
    directory: generatedFrontendProject,
    service: "frontend",
    project: frontendRoot,
    dockerfile: "Dockerfile",
    context: ".",
    imageName: "azure-sdk-qa-bot",
    tag: process.env.FRONTEND_IMAGE_TAG?.trim(),
    remoteBuild: true,
    environment: {
      RAG_SERVICE_SCOPE:
        process.env.RAG_SERVICE_SCOPE?.trim() || "${RAG_SERVICE_SCOPE}",
    },
  } as const;
}

async function writeTeamsEnvironment(): Promise<string> {
  const environment = requiredEnv("AZURE_ENV_NAME");
  const baseName = environment === "preview" ? "preprod" : environment;
  const baseFile = resolve(frontendRoot, "env", `.env.${baseName}`);
  const outputFile = resolve(frontendRoot, "env", `.env.${teamsEnvironment}`);
  let values = parseEnvironment(await readFile(baseFile, "utf8").catch(() => ""));
  for (const key of ["TEAMS_APP_ID", "TEAMS_APP_TENANT_ID", "TEAMS_APP_PUBLISHED_APP_ID"]) {
    delete values[key];
  }
  const teamsAppId =
    optionalEnv("TEAMS_APP_MANIFEST_ID") ?? optionalEnv("TEAMS_APP_ID");
  values = {
    ...values,
    TEAMSFX_ENV: teamsEnvironment,
    BOT_AZURE_APP_SERVICE_RESOURCE_ID: requiredEnv(
      "BOT_AZURE_APP_SERVICE_RESOURCE_ID",
    ),
    BOT_DOMAIN: requiredEnv("BOT_DOMAIN"),
    BOT_ID: requiredEnv("BOT_ID"),
    BOT_TENANT_ID: requiredEnv("BOT_TENANT_ID"),
    AZURE_SUBSCRIPTION_ID: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    AZURE_RESOURCE_GROUP_NAME: requiredEnv("AZURE_RESOURCE_GROUP"),
  };
  if (teamsAppId) values.TEAMS_APP_ID = teamsAppId;
  const teamsAppTenantId = optionalEnv("TEAMS_APP_TENANT_ID");
  if (teamsAppTenantId) values.TEAMS_APP_TENANT_ID = teamsAppTenantId;
  values.TEAMS_APP_TENANT_ID ??= requiredEnv("BOT_TENANT_ID");
  await writeFile(
    outputFile,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${quoteEnvironmentValue(value)}`)
      .join("\n")}\n`,
  );
  return outputFile;
}

function parseEnvironment(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function quoteEnvironmentValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
}