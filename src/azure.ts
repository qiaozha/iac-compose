import type { Deployment } from "./index.js";
import { createAzdProject } from "./azd.js";

const builtInRoleDefinitionIds: Readonly<Record<string, string>> = {
  AcrPull: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  AcrPush: "8311e382-0749-4cb8-b61a-304f252e45ec",
  "App Configuration Data Owner": "5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b",
  "App Configuration Data Reader": "516239f1-63e1-4d78-a4de-a74fb236a071",
  "Azure AI Developer": "64702f94-c441-49e6-a78b-ef80e0188fee",
  "Azure AI User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Foundry User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  "Storage Blob Data Contributor": "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
};

export async function runAzure(
  deployment: Deployment,
  args: readonly string[],
): Promise<void> {
  await deployment.execute({ command: "az", args });
}

export async function captureAzure(
  deployment: Deployment,
  args: readonly string[],
): Promise<string> {
  return deployment.capture({ command: "az", args });
}

export async function captureAzureJson<T>(
  deployment: Deployment,
  args: readonly string[],
): Promise<T> {
  const output = await captureAzure(deployment, [...args, "--output", "json"]);
  return JSON.parse(output) as T;
}

export async function retry<T>(
  action: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 8;
  const delayMs = options.delayMs ?? 15_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (
        attempt === attempts ||
        (options.shouldRetry && !options.shouldRetry(error))
      ) {
        throw error;
      }
      await delay(delayMs);
    }
  }
  throw lastError;
}

export async function waitForHttp(
  url: string,
  options: {
    attempts?: number;
    delayMs?: number;
    acceptedStatuses?: readonly number[];
  } = {},
): Promise<Response> {
  const attempts = options.attempts ?? 12;
  const acceptedStatuses = options.acceptedStatuses ?? [200];
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      lastStatus = response.status;
      if (acceptedStatuses.includes(response.status)) return response;
    } catch {
      lastStatus = 0;
    }
    if (attempt < attempts) await delay(options.delayMs ?? 10_000);
  }
  throw new Error(
    `${url} did not become ready (last HTTP status: ${lastStatus}).`,
  );
}

export function authorizationError(error: unknown): boolean {
  return /Forbidden|Authorization|not authorized|403/i.test(String(error));
}

export interface ContainerImageOptions {
  repository: string;
  context: string;
  dockerfile?: string;
  explicitTag?: string;
  registryName?: string;
  registryEndpoint?: string;
  tagPrefix?: string;
}

export async function buildContainerImage(
  deployment: Deployment,
  options: ContainerImageOptions,
): Promise<string> {
  const registry =
    options.registryName ?? requiredProcessEnvironment("CONTAINER_REGISTRY_NAME");
  const loginServer =
    options.registryEndpoint ??
    process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT?.trim() ??
    `${registry}.azurecr.io`;
  const tag =
    options.explicitTag ??
    (await nextImageTag(
      deployment,
      registry,
      options.repository,
      options.tagPrefix ??
        deployment.environment ??
        requiredProcessEnvironment("AZURE_ENV_NAME"),
    ));
  const args = [
    "acr",
    "build",
    "--registry",
    registry,
    "--image",
    `${options.repository}:${tag}`,
  ];
  if (options.dockerfile) args.push("--file", options.dockerfile);
  args.push(options.context);
  await runAzure(deployment, args);
  return `${loginServer}/${options.repository}:${tag}`;
}

export interface AppServiceContainerOptions {
  directory: string;
  service: string;
  projectName?: string;
  resourceName?: string;
  host?: "appservice" | "function";
  project?: string;
  image?: string;
  dockerfile?: string;
  context?: string;
  registry?: string;
  imageName?: string;
  tag?: string;
  remoteBuild?: boolean;
  environment?: Readonly<Record<string, string>>;
}

export interface AppServiceIngressOptions {
  resourceGroup: string;
  siteName: string;
  serviceTags: readonly string[];
  defaultAction?: "Allow" | "Deny";
  ipAddresses?: readonly string[];
  ruleNamePrefix?: string;
  subscription?: string;
  priorityStart?: number;
}

export interface AppServicePeerIngressOptions {
  resourceGroup: string;
  sourceSiteName: string;
  targetSiteName: string;
  sourceResourceName?: string;
  subscription?: string;
  priorityStart?: number;
}

export interface AppServiceReadyOptions {
  resourceGroup: string;
  siteName: string;
  subscription: string;
  attempts?: number;
  delayMs?: number;
}

interface AppServiceAccessRestriction {
  action?: string;
  ipAddress?: string;
  priority?: number;
  tag?: string;
}

export async function waitForAppServiceReady(
  deployment: Deployment,
  options: AppServiceReadyOptions,
): Promise<void> {
  const instancesUri =
    `https://management.azure.com/subscriptions/${encodeURIComponent(options.subscription)}` +
    `/resourceGroups/${encodeURIComponent(options.resourceGroup)}` +
    `/providers/Microsoft.Web/sites/${encodeURIComponent(options.siteName)}` +
    "/instances?api-version=2024-11-01";
  await retry(
    async () => {
      const state = (
        await captureAzure(deployment, [
          "rest",
          "--method",
          "get",
          "--uri",
          instancesUri,
          "--query",
          "value[0].properties.state",
          "--output",
          "tsv",
        ])
      ).trim();
      if (state.toUpperCase() !== "READY") {
        throw new Error(
          `App Service '${options.siteName}' instance state is '${state || "Unavailable"}'.`,
        );
      }
    },
    {
      attempts: options.attempts ?? 20,
      delayMs: options.delayMs ?? 15_000,
    },
  );
}

export async function ensureAppServiceIngress(
  deployment: Deployment,
  options: AppServiceIngressOptions,
): Promise<readonly string[]> {
  const subscriptionArgs = options.subscription
    ? ["--subscription", options.subscription]
    : [];
  const restrictions = await captureAzureJson<
    readonly AppServiceAccessRestriction[]
  >(deployment, [
    "webapp",
    "config",
    "access-restriction",
    "show",
    ...subscriptionArgs,
    "--resource-group",
    options.resourceGroup,
    "--name",
    options.siteName,
    "--query",
    "ipSecurityRestrictions",
  ]);
  const existingTags = new Set(
    restrictions
      .filter(
        (restriction) =>
          restriction.action?.toLowerCase() === "allow" &&
          restriction.tag?.toLowerCase() === "servicetag",
      )
      .map((restriction) => restriction.ipAddress?.toLowerCase())
      .filter((tag): tag is string => tag !== undefined),
  );
  const existingIpAddresses = new Set(
    restrictions
      .filter(
        (restriction) => restriction.action?.toLowerCase() === "allow",
      )
      .map((restriction) => normalizeIpAddress(restriction.ipAddress ?? ""))
      .filter(Boolean),
  );
  const usedPriorities = new Set(
    restrictions
      .map((restriction) => restriction.priority)
      .filter((priority): priority is number => priority !== undefined),
  );
  const added: string[] = [];
  let priority = options.priorityStart ?? 200;
  for (const serviceTag of [...new Set(options.serviceTags)]) {
    if (existingTags.has(serviceTag.toLowerCase())) continue;
    while (usedPriorities.has(priority)) priority += 1;
    await runAzure(deployment, [
      "webapp",
      "config",
      "access-restriction",
      "add",
      ...subscriptionArgs,
      "--resource-group",
      options.resourceGroup,
      "--name",
      options.siteName,
      "--rule-name",
      `Allow ${serviceTag}`,
      "--action",
      "Allow",
      "--priority",
      String(priority),
      "--service-tag",
      serviceTag,
      "--output",
      "none",
    ]);
    existingTags.add(serviceTag.toLowerCase());
    usedPriorities.add(priority);
    added.push(serviceTag);
    priority += 1;
  }
  const ipAddresses = [
    ...new Set(
      (options.ipAddresses ?? [])
        .map(normalizeIpAddress)
        .filter(Boolean),
    ),
  ];
  for (const [index, ipAddress] of ipAddresses.entries()) {
    if (existingIpAddresses.has(ipAddress)) continue;
    while (usedPriorities.has(priority)) priority += 1;
    await runAzure(deployment, [
      "webapp",
      "config",
      "access-restriction",
      "add",
      ...subscriptionArgs,
      "--resource-group",
      options.resourceGroup,
      "--name",
      options.siteName,
      "--rule-name",
      `${options.ruleNamePrefix ?? "Allow IP"} ${index + 1}`,
      "--action",
      "Allow",
      "--priority",
      String(priority),
      "--ip-address",
      ipAddress,
      "--output",
      "none",
    ]);
    existingIpAddresses.add(ipAddress);
    usedPriorities.add(priority);
    added.push(ipAddress);
    priority += 1;
  }
  if (options.defaultAction) {
    const currentDefaultAction = (
      await captureAzure(deployment, [
        "webapp",
        "config",
        "access-restriction",
        "show",
        ...subscriptionArgs,
        "--resource-group",
        options.resourceGroup,
        "--name",
        options.siteName,
        "--query",
        "ipSecurityRestrictionsDefaultAction",
        "--output",
        "tsv",
      ])
    ).trim();
    if (currentDefaultAction.toLowerCase() !== options.defaultAction.toLowerCase()) {
      await runAzure(deployment, [
        "webapp",
        "config",
        "access-restriction",
        "set",
        ...subscriptionArgs,
        "--resource-group",
        options.resourceGroup,
        "--name",
        options.siteName,
        "--default-action",
        options.defaultAction,
        "--output",
        "none",
      ]);
    }
  }
  return added;
}

export async function ensureAppServicePeerIngress(
  deployment: Deployment,
  options: AppServicePeerIngressOptions,
): Promise<readonly string[]> {
  const subscriptionArgs = options.subscription
    ? ["--subscription", options.subscription]
    : [];
  const possibleOutboundIpAddresses = (
    await captureAzure(deployment, [
      "webapp",
      "show",
      ...subscriptionArgs,
      "--resource-group",
      options.resourceGroup,
      "--name",
      options.sourceSiteName,
      "--query",
      "possibleOutboundIpAddresses",
      "--output",
      "tsv",
    ])
  )
    .split(",")
    .map(normalizeIpAddress)
    .filter(Boolean);
  if (possibleOutboundIpAddresses.length === 0) {
    throw new Error(
      `App Service '${options.sourceSiteName}' returned no possible outbound IP addresses.`,
    );
  }
  return ensureAppServiceIngress(deployment, {
    resourceGroup: options.resourceGroup,
    siteName: options.targetSiteName,
    serviceTags: [],
    ipAddresses: possibleOutboundIpAddresses,
    ruleNamePrefix: `Allow ${options.sourceResourceName ?? options.sourceSiteName}`,
    ...(options.subscription ? { subscription: options.subscription } : {}),
    ...(options.priorityStart === undefined
      ? {}
      : { priorityStart: options.priorityStart }),
  });
}

function normalizeIpAddress(value: string): string {
  return value.trim().toLowerCase().replace(/\/(?:32|128)$/, "");
}

export async function deployAppServiceContainer(
  deployment: Deployment,
  options: AppServiceContainerOptions,
): Promise<Record<string, string>> {
  const project = await prepareAppServiceContainer(deployment, options);
  return project.deploy(
    options.service,
    options.image ? { fromPackage: options.image } : {},
  );
}

export async function prepareAppServiceContainer(
  deployment: Deployment,
  options: AppServiceContainerOptions,
) {
  const project = createAzdProject(deployment, {
    directory: options.directory,
    mergeManifest: true,
    manifest: createAppServiceContainerManifest(options),
    values: {
      AZURE_CONTAINER_REGISTRY_ENDPOINT:
        options.registry ?? process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
    },
  });
  await project.initialize();
  return project;
}

export function createAppServiceContainerManifest(
  options: AppServiceContainerOptions,
): Readonly<Record<string, unknown>> {
  if (!options.project && !options.image) {
    throw new Error(
      `Service '${options.service}' requires either project source or a prebuilt image.`,
    );
  }
  if (options.project && options.image) {
    throw new Error(
      `Service '${options.service}' cannot specify both project source and image.`,
    );
  }
  const host = options.host ?? "appservice";
  if (host === "function" && options.environment) {
    throw new Error(
      `Function service '${options.service}' must configure app settings through infrastructure.`,
    );
  }
  return {
    name: options.projectName ?? `deploy-${options.service}`,
    ...(host === "function"
      ? { requiredVersions: { azd: ">= 1.30.0" } }
      : {}),
    services: {
      [options.service]: {
        host,
        language: "docker",
        ...(options.resourceName
          ? { resourceName: options.resourceName }
          : {}),
        ...(options.project
          ? {
              project: options.project,
              docker: {
                path: options.dockerfile ?? "Dockerfile",
                context: options.context ?? ".",
                registry:
                  options.registry ?? "${AZURE_CONTAINER_REGISTRY_ENDPOINT}",
                image: options.imageName ?? options.service,
                ...(options.tag ? { tag: options.tag } : {}),
                remoteBuild: options.remoteBuild ?? true,
              },
            }
          : { image: options.image }),
        ...(options.environment && Object.keys(options.environment).length > 0
          ? { env: options.environment }
          : {}),
      },
    },
  };
}

export interface AzureRoleAssignmentOptions {
  principalId: string;
  principalType?: string;
  role: string;
  scope: string;
  includeInherited?: boolean;
}

export interface AzureResourceGroupOptions {
  name: string;
  location: string;
  subscription?: string;
}

export async function ensureResourceGroup(
  deployment: Deployment,
  options: AzureResourceGroupOptions,
): Promise<void> {
  const args = [
    "group",
    "create",
    "--name",
    options.name,
    "--location",
    options.location,
    "--output",
    "none",
  ];
  if (options.subscription) {
    args.push("--subscription", options.subscription);
  }
  await runAzure(deployment, args);
}

export async function ensureRoleAssignment(
  deployment: Deployment,
  options: AzureRoleAssignmentOptions,
): Promise<boolean> {
  const role = builtInRoleDefinitionIds[options.role] ?? options.role;
  const listArgs = [
    "role",
    "assignment",
    "list",
    "--assignee",
    options.principalId,
    "--role",
    role,
    "--scope",
    options.scope,
    ...(options.includeInherited ? ["--include-inherited"] : []),
    "--query",
    "[0].id",
    "--output",
    "tsv",
  ];
  const existing = (
    await captureAzure(deployment, listArgs)
  ).trim();
  if (existing) return false;
  await runAzure(deployment, [
    "role",
    "assignment",
    "create",
    "--assignee-object-id",
    options.principalId,
    "--assignee-principal-type",
    options.principalType ?? "ServicePrincipal",
    "--role",
    role,
    "--scope",
    options.scope,
    "--output",
    "none",
  ]);
  return true;
}

export interface AzureAccountContextOptions {
  subscriptionId?: string;
  tenantId?: string;
  principalId?: string;
  principalType?: string;
}

export interface AzureSubscriptionContextOptions {
  subscriptionId?: string;
  tenantId?: string;
}

export interface AzureSubscriptionContext {
  subscriptionId: string;
  tenantId: string;
}

export interface AzureAccountContext {
  subscriptionId: string;
  tenantId: string;
  principalId: string;
  principalType: string;
}

export async function resolveAzureAccountContext(
  deployment: Deployment,
  options: AzureAccountContextOptions = {},
): Promise<AzureAccountContext> {
  const subscription = await resolveAzureSubscriptionContext(
    deployment,
    options,
  );
  const principalId =
    options.principalId?.trim() ||
    (
      await captureAzure(deployment, [
        "ad",
        "signed-in-user",
        "show",
        "--query",
        "id",
        "--output",
        "tsv",
      ])
    ).trim();
  return {
    ...subscription,
    principalId,
    principalType: options.principalType?.trim() || "User",
  };
}

export async function resolveAzureSubscriptionContext(
  deployment: Deployment,
  options: AzureSubscriptionContextOptions = {},
): Promise<AzureSubscriptionContext> {
  let subscriptionId = options.subscriptionId?.trim();
  if (subscriptionId) {
    await runAzure(deployment, [
      "account",
      "set",
      "--subscription",
      subscriptionId,
    ]);
  } else {
    subscriptionId = (
      await captureAzure(deployment, [
        "account",
        "show",
        "--query",
        "id",
        "--output",
        "tsv",
      ])
    ).trim();
  }
  const tenantId = (
    await captureAzure(deployment, [
      "account",
      "show",
      "--query",
      "tenantId",
      "--output",
      "tsv",
    ])
  ).trim();
  if (options.tenantId?.trim() && options.tenantId.trim() !== tenantId) {
    throw new Error(
      `Subscription '${subscriptionId}' is in tenant '${tenantId}', ` +
        `not configured tenant '${options.tenantId.trim()}'.`,
    );
  }
  return { subscriptionId, tenantId };
}

async function nextImageTag(
  deployment: Deployment,
  registry: string,
  repository: string,
  prefix: string,
): Promise<string> {
  const tags = await captureAzureJson<string[]>(deployment, [
    "acr",
    "repository",
    "show-tags",
    "--name",
    registry,
    "--repository",
    repository,
    "--orderby",
    "time_desc",
  ]).catch(() => []);
  const expression = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)\\.\\d+\\.\\d+$`);
  const major = tags.reduce((highest, tag) => {
    const match = expression.exec(tag);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `${prefix}-${major + 1}.0.0`;
}

function requiredProcessEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required deployment value '${name}' is not configured.`);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}