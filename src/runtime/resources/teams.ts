import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Deployment } from "../../index.js";
import type { ResourceContractRequirement } from "../../shared/contracts/resources/types.js";
import type { DeployResourceComponentOptions } from "./types.js";
import {
  asObject,
  findComponentSource,
  requiredString,
  resolveOutputBindings,
} from "./values.js";

export interface TeamsApplicationDeploymentOptions {
  component: string;
  componentDirectory: string;
  existingAppId?: string;
  manifestValues: Readonly<Record<string, string>>;
  outputNames?: readonly string[];
}

export async function deployTeamsApplicationResource(
  deployment: Deployment,
  options: DeployResourceComponentOptions,
  resource: ResourceContractRequirement,
): Promise<Record<string, string>> {
  const source = options.source ?? findComponentSource(options.resources);
  if (!source) {
    throw new Error(
      `Teams application '${resource.id}' requires a component source directory.`,
    );
  }
  const configuration = asObject(resource.configuration);
  const manifestValues = asObject(configuration.manifestValues);
  return provisionTeamsApplication(deployment, {
    component: options.component,
    componentDirectory: resolve(options.packageDirectory, source),
    manifestValues: Object.fromEntries(
      Object.entries(manifestValues)
        .filter(([name]) => name !== "TEAMS_APP_ID")
        .map(([name, value]) => [
          name,
          resolveOutputBindings(
            requiredString(
              value,
              `${resource.id}.configuration.manifestValues.${name}`,
            ),
          ),
        ]),
    ),
    outputNames: resource.produces,
  });
}

export async function provisionTeamsApplication(
  deployment: Deployment,
  options: TeamsApplicationDeploymentOptions,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  await deployment.deploy(`${options.component} Teams application`, async () => {
    const componentDirectory = resolve(options.componentDirectory);
    await readFile(resolve(componentDirectory, "teamsapp.yml"), "utf8");
    const environmentDirectory = resolve(componentDirectory, "env");
    const teamsEnvironment = teamsEnvironmentName(
      deployment.environment ?? process.env.AZURE_ENV_NAME,
    );
    const environmentFile = resolve(
      environmentDirectory,
      `.env.${teamsEnvironment}`,
    );
    const existing = parseEnvironment(
      await readFile(environmentFile, "utf8").catch(() => ""),
    );
    const environment: Record<string, string> = {
      ...existing,
      TEAMSFX_ENV: teamsEnvironment,
    };
    Object.assign(environment, options.manifestValues);
    environment.TEAMS_APP_VERSION =
      options.manifestValues.TEAMS_APP_VERSION?.trim() ||
      teamsApplicationVersion();
    environment.TEAMS_APP_NAME ??=
      options.manifestValues.TEAMS_BOT_FULL_DISPLAY_NAME?.trim() ||
      options.component;
    const existingAppId =
      options.existingAppId?.trim() ||
      process.env.TEAMS_APP_ID?.trim() ||
      existing.TEAMS_APP_ID;
    if (existingAppId) environment.TEAMS_APP_ID = existingAppId;
    await mkdir(environmentDirectory, { recursive: true });
    await writeFile(environmentFile, serializeEnvironment(environment));
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
      cwd: componentDirectory,
      env: {
        CI: "",
        TF_BUILD: "",
        TEAMSFX_INTERACTIVE: "true",
        ...(existingAppId ? { TEAMS_APP_ID: existingAppId } : {}),
      },
    });
    const provisioned = parseEnvironment(await readFile(environmentFile, "utf8"));
    const teamsAppId = provisioned.TEAMS_APP_ID?.trim();
    if (!teamsAppId) {
      throw new Error(
        `Teams application '${options.component}' did not produce TEAMS_APP_ID.`,
      );
    }
    values.TEAMS_APP_ID = teamsAppId;
    for (const output of options.outputNames ?? []) values[output] = teamsAppId;
  });
  return values;
}

export function teamsEnvironmentName(environment = "dev"): string {
  const normalized = environment
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `iac-compose-${normalized || "dev"}`;
}

function parseEnvironment(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function serializeEnvironment(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${quoteEnvironmentValue(value)}`)
    .join("\n")}\n`;
}

function teamsApplicationVersion(now = Date.now()): string {
  const partSize = 65_536;
  const major = Math.floor(now / (partSize * partSize));
  const minor = Math.floor(now / partSize) % partSize;
  const patch = now % partSize;
  return `${major}.${minor}.${patch}`;
}

function quoteEnvironmentValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
}