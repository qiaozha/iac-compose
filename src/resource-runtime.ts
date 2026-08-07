import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  captureAzure,
  deployAppServiceContainer,
  ensureRoleAssignment,
  prepareAppServiceContainer,
} from "./azure.js";
import { createAzdProject } from "./azd.js";
import type { Deployment } from "./index.js";
import type {
  ResourceContract,
  ResourceContractRequirement,
} from "./resource-contract.js";

export interface DeployResourceComponentOptions {
  component: string;
  kind?: string;
  packageDirectory: string;
  generatedDirectory: string;
  source?: string;
  resources: readonly ResourceContractRequirement[];
}

export interface AuthorizedConnectionOptions {
  resourceId: string;
  name: string;
}

export async function prepareAuthorizedConnection(
  deployment: Deployment,
  options: AuthorizedConnectionOptions,
): Promise<string> {
  const status = (
    await captureAzure(deployment, [
      "resource",
      "show",
      "--subscription",
      requiredProcessValue("AZURE_SUBSCRIPTION_ID"),
      "--resource-group",
      requiredProcessValue("AZURE_RESOURCE_GROUP"),
      "--resource-type",
      "Microsoft.Web/connections",
      "--name",
      options.name,
      "--api-version",
      "2016-06-01",
      "--query",
      "properties.statuses[0].status",
      "--output",
      "tsv",
    ]).catch(() => "")
  ).trim();
  process.env[resourceCreateEnvironmentName(options.resourceId)] =
    status === "Connected" ? "false" : "true";
  return status;
}

export async function prepareResourceRequirements(
  deployment: Deployment,
  contract: ResourceContract,
): Promise<void> {
  for (const resource of contract.resources) {
    if (
      resource.kind !== "authorized-api-connection" ||
      resource.authorization !== "interactive"
    ) {
      continue;
    }
    await prepareAuthorizedConnection(deployment, {
      resourceId: resource.id,
      name: "teams",
    });
  }
}

export async function deployResourceComponent(
  deployment: Deployment,
  options: DeployResourceComponentOptions,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const containerResources = options.resources.filter(
    (resource) => resource.kind === "container-host",
  );
  if (options.kind === "hosted-agent") {
    if (containerResources.length !== 1) {
      throw new Error(
        `Hosted agent component '${options.component}' requires exactly one container-host resource.`,
      );
    }
    Object.assign(
      values,
      await deployHostedAgent(deployment, options, containerResources[0]!),
    );
  } else for (const resource of containerResources) {
    const service =
      containerResources.length === 1
        ? options.component
        : `${options.component}-${resource.id}`;
    const source = resource.source ?? options.source;
    if (!source) {
      throw new Error(
        `Container resource '${resource.id}' requires a component source directory.`,
      );
    }
    const resourceName = process.env[resourceOutputName(resource.id, "NAME")]?.trim();
    if (!resourceName && !deployment.dryRun) {
      throw new Error(
        `Provisioning output '${resourceOutputName(resource.id, "NAME")}' is missing.`,
      );
    }
    const serviceOptions = {
      directory: options.generatedDirectory,
      service,
      ...(resourceName ? { resourceName } : {}),
      project: resolve(options.packageDirectory, source),
      dockerfile: "Dockerfile",
      context: ".",
      registry: process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
      imageName: normalizeImageName(service),
      remoteBuild: true,
      environment: resolveRuntimeSettings(resource, deployment.dryRun),
    } as const;
    if (deployment.dryRun) {
      await prepareAppServiceContainer(deployment, serviceOptions);
    }
    await deployment.deploy(`${options.component} container '${resource.id}'`, async () => {
      Object.assign(values, await deployAppServiceContainer(deployment, serviceOptions));
    });
  }

  for (const resource of options.resources) {
    if (resource.kind === "teams-application") {
      Object.assign(values, await deployTeamsApplication(deployment, options, resource));
    } else if (resource.kind === "workflow-host") {
      await enableWorkflow(deployment, options, resource);
    }
  }
  Object.assign(process.env, values);
  return values;
}

interface HostedAgentVersion {
  name: string;
  version: string;
  status: string;
  instance_identity?: { principal_id?: string };
}

export interface HostedAgentAccess {
  role: string;
  scope: string;
}

export interface HostedAgentDeploymentOptions {
  component: string;
  generatedDirectory: string;
  sourceDirectory: string;
  name: string;
  environment: Readonly<Record<string, string>>;
  endpointOutput: string;
  principalIdOutput: string;
  access?: readonly HostedAgentAccess[];
  configurationStoreName?: string;
}

export async function deployHostedAgentService(
  deployment: Deployment,
  options: HostedAgentDeploymentOptions,
): Promise<Record<string, string>> {
  const project = createAzdProject(deployment, {
    directory: options.generatedDirectory,
    mergeManifest: true,
    manifest: createHostedAgentManifest({
      service: options.component,
      sourceDirectory: options.sourceDirectory,
      name: options.name,
      environment: Object.fromEntries(
        Object.keys(options.environment).map((name) => [name, `\${${name}}`]),
      ),
    }),
    values: {
      AZURE_CONTAINER_REGISTRY_ENDPOINT:
        process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
      AZURE_AI_PROJECT_ID: process.env.AZURE_AI_PROJECT_ID,
      FOUNDRY_PROJECT_ENDPOINT: process.env.FOUNDRY_PROJECT_ENDPOINT,
      ...options.environment,
    },
  });
  if (deployment.dryRun) await project.initialize();

  const outputs: Record<string, string> = {};
  await deployment.deploy(`${options.component} hosted Foundry agent`, async () => {
    const azdValues = await project.deploy(options.component);
    const active = parseHostedAgentVersion(
      await project.capture([
        "ai",
        "agent",
        "show",
        options.component,
        "--environment",
        project.environment,
        "--output",
        "json",
        "--no-prompt",
      ]),
    );
    if (active.status !== "active") {
      throw new Error(
        `azd completed hosted agent deployment with status '${active.status}'.`,
      );
    }
    const principalId = active.instance_identity?.principal_id?.trim();
    if (!principalId) {
      throw new Error("Hosted agent version did not return an instance identity.");
    }
    Object.assign(outputs, azdValues, {
      [options.endpointOutput]: hostedAgentEndpoint(
        azdValues,
        options.component,
      ),
      [options.principalIdOutput]: principalId,
      agentName: active.name,
      agentVersion: active.version,
    });
    for (const access of options.access ?? []) {
      await ensureRoleAssignment(deployment, {
        principalId,
        role: access.role,
        scope: access.scope,
      });
    }
    if (options.configurationStoreName) {
      await updateAgentConfigurationStore(
        deployment,
        options.configurationStoreName,
        active.name,
        active.version,
      );
    }
  });
  return outputs;
}

async function deployHostedAgent(
  deployment: Deployment,
  options: DeployResourceComponentOptions,
  resource: ResourceContractRequirement,
): Promise<Record<string, string>> {
  const source = resource.source ?? options.source;
  if (!source) {
    throw new Error(`Hosted agent resource '${resource.id}' requires a source directory.`);
  }
  const principalOutputs = new Set(resource.produces ?? []);
  const access: HostedAgentAccess[] = [];
  for (const candidate of options.resources) {
    for (const grant of candidate.access ?? []) {
      if (!principalOutputs.has(grant.principalOutput)) continue;
      access.push({
        role: grant.role,
        scope: requiredProcessValue(
          resourceOutputName(candidate.id, "ACCESS_SCOPE"),
        ),
      });
    }
  }
  const configuration = options.resources.find(
    (candidate) => candidate.kind === "configuration-store",
  );
  const endpointOutput =
    resource.produces?.find((output) => /Endpoint$/i.test(output)) ??
    "agentEndpoint";
  const principalIdOutput =
    resource.produces?.find((output) => /IdentityPrincipalId$/i.test(output)) ??
    "agentIdentityPrincipalId";
  return deployHostedAgentService(deployment, {
    component: options.component,
    generatedDirectory: options.generatedDirectory,
    sourceDirectory: resolve(options.packageDirectory, source),
    name: process.env.agentName?.trim() || options.component,
    environment: resolveRuntimeSettings(resource, deployment.dryRun),
    endpointOutput,
    principalIdOutput,
    access,
    ...(configuration
      ? {
          configurationStoreName: requiredProcessValue(
            resourceOutputName(configuration.id, "NAME"),
          ),
        }
      : {}),
  });
}

interface HostedAgentManifestOptions {
  service: string;
  sourceDirectory: string;
  name: string;
  environment: Readonly<Record<string, string>>;
}

export function createHostedAgentManifest(
  options: HostedAgentManifestOptions,
): Readonly<Record<string, unknown>> {
  return {
    name: `deploy-${options.service}`,
    services: {
      [options.service]: {
        project: ".",
        host: "azure.ai.agent",
        language: "python",
        docker: {
          path: resolve(options.sourceDirectory, "Dockerfile"),
          context: options.sourceDirectory,
          registry: "${AZURE_CONTAINER_REGISTRY_ENDPOINT}",
          image: normalizeImageName(options.service),
          remoteBuild: true,
        },
        kind: "hosted",
        name: options.name,
        protocols: [{ protocol: "responses", version: "2.0.0" }],
        config: { container: { resources: { cpu: "0.5", memory: "1Gi" } } },
        container: { resources: { cpu: "0.5", memory: "1Gi" } },
        startupCommand: "python3 -u init.py",
        env: options.environment,
      },
    },
  };
}

export function parseHostedAgentVersion(output: string): HostedAgentVersion {
  const value: unknown = JSON.parse(output);
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !("status" in value) ||
    typeof value.status !== "string"
  ) {
    throw new Error("azd ai agent show returned an invalid agent version.");
  }
  return value as HostedAgentVersion;
}

function hostedAgentEndpoint(
  values: Readonly<Record<string, string>>,
  service: string,
): string {
  const prefix = service.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  const endpoint =
    values[`${prefix}_AGENT_ENDPOINT`]?.trim() ||
    values.AGENT_AGENT_ENDPOINT?.trim() ||
    values[`${prefix}_ENDPOINT`]?.trim();
  if (!endpoint) throw new Error("azd deploy did not return a hosted agent endpoint.");
  return endpoint;
}

async function updateHostedAgentConfiguration(
  deployment: Deployment,
  resources: readonly ResourceContractRequirement[],
  agentName: string,
  agentVersion: string,
): Promise<void> {
  const configuration = resources.find(
    (resource) => resource.kind === "configuration-store",
  );
  if (!configuration) return;
  await updateAgentConfigurationStore(
    deployment,
    requiredProcessValue(resourceOutputName(configuration.id, "NAME")),
    agentName,
    agentVersion,
  );
}

async function updateAgentConfigurationStore(
  deployment: Deployment,
  storeName: string,
  agentName: string,
  agentVersion: string,
): Promise<void> {
  const subscription = requiredProcessValue("AZURE_SUBSCRIPTION_ID");
  for (const [key, value] of [
    ["AI_FOUNDRY_AGENT_NAME", agentName],
    ["AI_FOUNDRY_AGENT_VERSION", agentVersion],
  ] as const) {
    await deployment.execute({
      command: "az",
      args: appConfigurationKeySetArgs(
        subscription,
        storeName,
        key,
        value,
      ),
    });
  }
}

export function appConfigurationKeySetArgs(
  subscription: string,
  storeName: string,
  key: string,
  value: string,
): string[] {
  return [
    "appconfig",
    "kv",
    "set",
    "--subscription",
    subscription,
    "--name",
    storeName,
    "--auth-mode",
    "login",
    "--key",
    key,
    "--value",
    value,
    "--yes",
    "--output",
    "none",
  ];
}

function resolveRuntimeSettings(
  resource: ResourceContractRequirement,
  allowMissing: boolean,
): Readonly<Record<string, string>> {
  const configuration = asObject(resource.configuration);
  const settings = asObject(configuration.runtimeSettings);
  return Object.fromEntries(
    Object.entries(settings).map(([name, value]) => [
      name,
      resolveOutputBindings(
        requiredString(value, `${resource.id}.${name}`),
        process.env,
        allowMissing,
      ),
    ]),
  );
}

async function deployTeamsApplication(
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
  const manifestValues = asObject(asObject(resource.configuration).manifestValues);
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

export interface TeamsApplicationDeploymentOptions {
  component: string;
  componentDirectory: string;
  manifestValues: Readonly<Record<string, string>>;
  outputNames?: readonly string[];
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
    environment.TEAMS_APP_NAME ??=
      options.manifestValues.TEAMS_BOT_FULL_DISPLAY_NAME?.trim() ||
      options.component;
    const existingAppId = process.env.TEAMS_APP_ID?.trim() || existing.TEAMS_APP_ID;
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

async function enableWorkflow(
  deployment: Deployment,
  options: DeployResourceComponentOptions,
  resource: ResourceContractRequirement,
): Promise<void> {
  const placeholder = findContractPlaceholder(resource.parameters);
  if (placeholder) {
    throw new Error(
      `Workflow resource '${resource.id}' cannot be enabled while '${placeholder.path}' ` +
        `contains placeholder '${placeholder.value}'.`,
    );
  }
  const connection = options.resources.find(
    (candidate) =>
      candidate.kind === "authorized-api-connection" &&
      candidate.authorization === "interactive",
  );
  const authorizationTenantId = connection
    ? connectionAuthorizationTenantId(connection)
    : undefined;
  await enableWorkflowDeployment(deployment, {
    component: options.component,
    workflowId: resource.id,
    workflowName: requiredProcessValue(resourceOutputName(resource.id, "NAME")),
    validationValues: resource.parameters,
    ...(connection
      ? {
          connectionName: requiredProcessValue(
            resourceOutputName(connection.id, "NAME"),
          ),
        }
      : {}),
    ...(authorizationTenantId ? { authorizationTenantId } : {}),
  });
}

export interface WorkflowDeploymentOptions {
  component: string;
  workflowId: string;
  workflowName: string;
  validationValues?: unknown;
  connectionName?: string;
  authorizationTenantId?: string;
}

export async function enableWorkflowDeployment(
  deployment: Deployment,
  options: WorkflowDeploymentOptions,
): Promise<void> {
  await deployment.deploy(`${options.component} workflow '${options.workflowId}'`, async () => {
    const placeholder = findContractPlaceholder(options.validationValues);
    if (placeholder) {
      throw new Error(
        `Workflow resource '${options.workflowId}' cannot be enabled while '${placeholder.path}' ` +
          `contains placeholder '${placeholder.value}'.`,
      );
    }
    if (options.connectionName) {
      await requireAuthorizedConnection(
        deployment,
        options.connectionName,
        options.authorizationTenantId,
      );
    }
    await deployment.execute({
      command: "az",
      args: [
        "resource",
        "update",
        "--subscription",
        requiredProcessValue("AZURE_SUBSCRIPTION_ID"),
        "--resource-group",
        requiredProcessValue("AZURE_RESOURCE_GROUP"),
        "--resource-type",
        "Microsoft.Logic/workflows",
        "--name",
        options.workflowName,
        "--api-version",
        "2019-05-01",
        "--set",
        "properties.state=Enabled",
        "--output",
        "none",
      ],
    });
  });
}

async function requireAuthorizedConnection(
  deployment: Deployment,
  connectionName: string,
  authorizationTenantId?: string,
): Promise<void> {
  const subscription = requiredProcessValue("AZURE_SUBSCRIPTION_ID");
  const resourceGroup = requiredProcessValue("AZURE_RESOURCE_GROUP");
  const status = (
    await captureAzure(deployment, [
      "resource",
      "show",
      "--subscription",
      subscription,
      "--resource-group",
      resourceGroup,
      "--resource-type",
      "Microsoft.Web/connections",
      "--name",
      connectionName,
      "--api-version",
      "2016-06-01",
      "--query",
      "properties.statuses[0].status",
      "--output",
      "tsv",
    ]).catch(() => "")
  ).trim();
  if (status === "Connected") return;
  const tenant = process.env.AZURE_TENANT_ID?.trim() ?? "common";
  const resourceId =
    `/subscriptions/${subscription}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Web/connections/${connectionName}`;
  const authorizationAccount = authorizationTenantId
    ? ` with an account from tenant '${authorizationTenantId}'`
    : "";
  throw new Error(
    `API connection '${connectionName}' requires interactive consent ` +
      `(current status: '${status || "NotConnected"}'). Open ` +
      `https://portal.azure.com/#@${tenant}/resource${resourceId}/edit, ` +
      `authorize the connection${authorizationAccount}, then rerun deploy-js.`,
  );
}

function connectionAuthorizationTenantId(
  resource: ResourceContractRequirement,
): string | undefined {
  const value = resource.configuration?.tenantId;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `${resource.id}.configuration.tenantId must be a non-empty string.`,
    );
  }
  return value.trim();
}

export function resolveOutputBindings(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
  allowMissing = false,
): string {
  return value.replace(
    /\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g,
    (_binding, name: string) => {
      const resolved = environment[name]?.trim();
      if (!resolved) {
        if (allowMissing) return `\${${name}}`;
        throw new Error(`Deployment output '${name}' is not available.`);
      }
      return resolved;
    },
  );
}

export function teamsEnvironmentName(environment = "dev"): string {
  const normalized = environment
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `deploy-js-${normalized || "dev"}`;
}

function findContractPlaceholder(
  value: unknown,
  path = "parameters",
): { path: string; value: string } | undefined {
  if (typeof value === "string") {
    return /^<[^>]+>$/.test(value) || value.startsWith("REPLACE_WITH_")
      ? { path, value }
      : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const placeholder = findContractPlaceholder(value[index], `${path}[${index}]`);
      if (placeholder) return placeholder;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [name, child] of Object.entries(value)) {
      const placeholder = findContractPlaceholder(child, `${path}.${name}`);
      if (placeholder) return placeholder;
    }
  }
  return undefined;
}

function findComponentSource(
  resources: readonly ResourceContractRequirement[],
): string | undefined {
  return resources.find((resource) => resource.source)?.source;
}

function resourceOutputName(resourceId: string, suffix: string): string {
  return `DEPLOY_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

function resourceCreateEnvironmentName(resourceId: string): string {
  return `DEPLOY_CREATE_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function normalizeImageName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "application";
}

function requiredProcessValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required deployment value '${name}' is not configured.`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
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

function quoteEnvironmentValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
}