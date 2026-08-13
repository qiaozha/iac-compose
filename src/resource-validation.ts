import {
  captureAzure,
  ensureRoleAssignment,
  resolveAzureAccountContext,
} from "./azure.js";
import type {
  DeploymentSolution,
  ResourceRequirement,
  ResourceRequirements,
} from "./generator.js";
import type { Deployment } from "./index.js";

export interface DeploymentRoleRequirement {
  readonly provider: string;
  readonly role: string;
  readonly roleDefinitionId: string;
  readonly reason: string;
}

export interface ResourceValidationPlan {
  readonly providers: readonly string[];
  readonly roles: readonly DeploymentRoleRequirement[];
}

export interface ValidateResourceRequirementsOptions {
  readonly requirements: ResourceRequirements;
  readonly solution?: DeploymentSolution;
  readonly subscriptionId?: string;
  readonly tenantId?: string;
  readonly principalId?: string;
  readonly principalType?: string;
  readonly scope?: string;
  readonly resourceGroup?: string;
  readonly grant?: boolean;
}

export interface ResourceProviderValidation {
  readonly namespace: string;
  readonly registrationState: string;
}

export interface DeploymentRoleValidation extends DeploymentRoleRequirement {
  readonly granted: boolean;
  readonly present: boolean;
}

export interface ResourceRequirementsValidationResult {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly scope: string;
  readonly providers: readonly ResourceProviderValidation[];
  readonly roles: readonly DeploymentRoleValidation[];
}

const providerNamespacesByKind: Readonly<Record<string, readonly string[]>> = {
  "ai-project": ["Microsoft.CognitiveServices"],
  "application-monitoring": [
    "Microsoft.Insights",
    "Microsoft.OperationalInsights",
  ],
  "authorized-api-connection": ["Microsoft.Web"],
  "bot-identity": ["Microsoft.BotService", "Microsoft.ManagedIdentity"],
  "configuration-store": ["Microsoft.AppConfiguration"],
  "container-host": ["Microsoft.ManagedIdentity", "Microsoft.Web"],
  "container-registry": ["Microsoft.ContainerRegistry"],
  "document-database": ["Microsoft.DocumentDB"],
  "model-deployment": ["Microsoft.CognitiveServices"],
  "object-storage": ["Microsoft.Storage"],
  "teams-application": [],
  "workflow-host": ["Microsoft.Logic"],
};

const appConfigurationDataOwner: DeploymentRoleRequirement = {
  provider: "Microsoft.AppConfiguration",
  role: "App Configuration Data Owner",
  roleDefinitionId: "5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b",
  reason: "write generated application settings",
};

const containerRegistryPush: DeploymentRoleRequirement = {
  provider: "Microsoft.ContainerRegistry",
  role: "AcrPush",
  roleDefinitionId: "8311e382-0749-4cb8-b61a-304f252e45ec",
  reason: "publish generated component images",
};

const foundryUser: DeploymentRoleRequirement = {
  provider: "Microsoft.CognitiveServices",
  role: "Foundry User",
  roleDefinitionId: "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  reason: "deploy the hosted Foundry agent",
};

export function planResourceValidation(
  requirements: ResourceRequirements,
  solution?: DeploymentSolution,
): ResourceValidationPlan {
  const providers = new Set<string>();
  for (const resource of requirements.resources) {
    const baseProviders = providerNamespacesByKind[resource.kind];
    if (!baseProviders) {
      throw new Error(
        `Resource '${resource.id}' uses unsupported kind '${resource.kind}'.`,
      );
    }
    const supportedProviders = resource.kind === "container-host" &&
        hasPrivateEndpointSources(resource)
      ? [...baseProviders, "Microsoft.Network"]
      : baseProviders;
    for (const provider of supportedProviders) providers.add(provider);
    validateDeclaredProviders(resource, supportedProviders);
  }

  if (
    requirements.resources.some((resource) => resource.kind === "container-host")
  ) {
    providers.add("Microsoft.ContainerRegistry");
  }

  const roles: DeploymentRoleRequirement[] = [];
  if (
    requirements.resources.some(
      (resource) => resource.kind === "configuration-store",
    )
  ) {
    roles.push(appConfigurationDataOwner);
  }
  if (
    requirements.resources.some((resource) => resource.kind === "container-host")
  ) {
    roles.push(containerRegistryPush);
  }
  if (hasHostedAgent(requirements.resources, solution)) {
    roles.push(foundryUser);
  }

  return {
    providers: [...providers].sort(),
    roles,
  };
}

function hasPrivateEndpointSources(resource: ResourceRequirement): boolean {
  if (
    typeof resource.configuration !== "object" ||
    resource.configuration === null ||
    Array.isArray(resource.configuration)
  ) {
    return false;
  }
  const configuration = resource.configuration as Record<string, unknown>;
  const ingress = configuration.ingress;
  if (typeof ingress !== "object" || ingress === null || Array.isArray(ingress)) {
    return false;
  }
  const ingressConfiguration = ingress as Record<string, unknown>;
  const privateEndpoint = ingressConfiguration.privateEndpoint;
  const sourceResources =
    typeof privateEndpoint === "object" &&
      privateEndpoint !== null &&
      !Array.isArray(privateEndpoint)
      ? (privateEndpoint as Record<string, unknown>).sourceResources
      : ingressConfiguration.allowedSourceResources;
  return Array.isArray(sourceResources) && sourceResources.length > 0;
}

export async function validateResourceRequirements(
  deployment: Deployment,
  options: ValidateResourceRequirementsOptions,
): Promise<ResourceRequirementsValidationResult> {
  if (options.scope && options.resourceGroup) {
    throw new Error("Specify either scope or resourceGroup, not both.");
  }
  const plan = planResourceValidation(options.requirements, options.solution);
  const account = await resolveAzureAccountContext(deployment, {
    subscriptionId: options.subscriptionId,
    tenantId: options.tenantId,
    principalId: options.principalId,
    principalType: options.principalType,
  });
  const scope =
    options.scope?.trim() ||
    (options.resourceGroup?.trim()
      ? `/subscriptions/${account.subscriptionId}/resourceGroups/${options.resourceGroup.trim()}`
      : `/subscriptions/${account.subscriptionId}`);
  const providers: ResourceProviderValidation[] = [];
  for (const namespace of plan.providers) {
    const registrationState = (
      await captureAzure(deployment, [
        "provider",
        "show",
        "--subscription",
        account.subscriptionId,
        "--namespace",
        namespace,
        "--query",
        "registrationState",
        "--output",
        "tsv",
      ])
    ).trim();
    providers.push({ namespace, registrationState });
  }

  const roles: DeploymentRoleValidation[] = [];
  for (const role of plan.roles) {
    let granted = false;
    let present: boolean;
    if (options.grant) {
      granted = await ensureRoleAssignment(deployment, {
        principalId: account.principalId,
        principalType: account.principalType,
        role: role.roleDefinitionId,
        scope,
        includeInherited: true,
      });
      present = true;
    } else {
      present = await hasRoleAssignment(
        deployment,
        account.principalId,
        role.roleDefinitionId,
        scope,
      );
    }
    roles.push({ ...role, present, granted });
  }

  return { ...account, scope, providers, roles };
}

export async function ensureDeploymentPrincipalRoles(
  deployment: Deployment,
  options: {
    readonly subscriptionId: string;
    readonly tenantId?: string;
    readonly principalId?: string;
    readonly principalType?: string;
    readonly scope: string;
    readonly roles: readonly DeploymentRoleRequirement[];
  },
): Promise<void> {
  const account = await resolveAzureAccountContext(deployment, options);
  for (const role of options.roles) {
    await ensureRoleAssignment(deployment, {
      principalId: account.principalId,
      principalType: account.principalType,
      role: role.roleDefinitionId,
      scope: options.scope,
      includeInherited: true,
    });
  }
}

async function hasRoleAssignment(
  deployment: Deployment,
  principalId: string,
  roleDefinitionId: string,
  scope: string,
): Promise<boolean> {
  return Boolean(
    (
      await captureAzure(deployment, [
        "role",
        "assignment",
        "list",
        "--assignee",
        principalId,
        "--role",
        roleDefinitionId,
        "--scope",
        scope,
        "--include-inherited",
        "--query",
        "[0].id",
        "--output",
        "tsv",
      ])
    ).trim(),
  );
}

function validateDeclaredProviders(
  resource: ResourceRequirement,
  supportedProviders: readonly string[],
): void {
  if (resource.azureResourceTypes === undefined) return;
  if (!Array.isArray(resource.azureResourceTypes)) {
    throw new Error(`Resource '${resource.id}'.azureResourceTypes must be an array.`);
  }
  for (const [index, value] of resource.azureResourceTypes.entries()) {
    if (typeof value !== "string" || !value.includes("/")) {
      throw new Error(
        `Resource '${resource.id}'.azureResourceTypes[${index}] must be a provider-qualified resource type.`,
      );
    }
    const namespace = value.slice(0, value.indexOf("/"));
    if (!supportedProviders.includes(namespace)) {
      throw new Error(
        `Resource '${resource.id}' declares provider '${namespace}', which the '${resource.kind}' generator does not support.`,
      );
    }
  }
}

function hasHostedAgent(
  resources: readonly ResourceRequirement[],
  solution?: DeploymentSolution,
): boolean {
  const hostedComponents = new Set(
    solution?.components
      .filter((component) => component.kind === "hosted-agent")
      .map((component) => component.id) ?? [],
  );
  return resources.some(
    (resource) =>
      (Array.isArray(resource.capabilities) &&
        resource.capabilities.includes("hosted-agent")) ||
      resource.requiredBy.some((component) => hostedComponents.has(component)),
  );
}