import type { ResourceRequirement } from "../../contracts/deployment.js";
import { entraApplicationUniqueNamePrefix, identifier } from "../names.js";
import { outputBindings } from "../outputs.js";
import { resourceOwner } from "../ownership.js";
import type { ProvisioningSourceOptions } from "../types.js";
import {
  arrayValue,
  asObject,
  optionalBoolean,
  requiredArray,
  requiredString,
} from "../values.js";

export interface EntraApplicationPlan {
  resource: ResourceRequirement;
  base: string;
  uniqueNamePrefix: string;
  displayName: string;
  delegatedPermissionScope: string;
  authorizedClientApplicationIds: readonly string[];
  callerApplications: readonly {
    applicationId: string;
    principalOutput: string;
  }[];
  callerPrincipalOutputs: readonly string[];
}

export function hasEntraApplications(
  options: ProvisioningSourceOptions,
): boolean {
  return entraApplicationPlans(options).length > 0;
}

export function entraConfigurationOwner(
  options: ProvisioningSourceOptions,
): string | undefined {
  const plans = entraApplicationPlans(options);
  if (plans.length === 0) return undefined;
  const outputProducers = new Map<string, ResourceRequirement>();
  for (const resource of options.requirements.resources) {
    for (const output of resource.produces ?? []) {
      outputProducers.set(output, resource);
    }
  }
  const owners = new Set<string>();
  for (const plan of plans) {
    owners.add(resourceOwner(plan.resource));
    for (const output of plan.callerPrincipalOutputs) {
      const producer = outputProducers.get(output);
      for (const owner of producer?.requiredBy ?? []) owners.add(owner);
    }
  }
  const order = ["shared", ...options.orderedComponents];
  return [...owners].reduce((latest, owner) =>
    order.indexOf(owner) > order.indexOf(latest) ? owner : latest
  , "shared");
}

export function entraApplicationPlans(
  options: ProvisioningSourceOptions,
): EntraApplicationPlan[] {
  return options.requirements.resources.flatMap((resource) => {
    const authentication = microsoftEntraAuthentication(resource);
    if (!authentication) return [];
    const callerApplications = authentication.callerApplicationIds.map(
      (applicationId, index) => ({
        applicationId,
        principalOutput: entraOutput(
          resource.id,
          `CALLER_APPLICATION_${index + 1}_PRINCIPAL_ID`,
        ),
      }),
    );
    const callerPrincipalOutputs = new Set([
      ...entraCallerPrincipalOutputs(options, resource),
      ...callerApplications.map(({ principalOutput }) => principalOutput),
      ...(authentication.authorizeDeploymentPrincipal
        ? ["AZURE_PRINCIPAL_ID"]
        : []),
    ]);
    return [{
      resource,
      base: identifier(resource.id),
      uniqueNamePrefix: entraApplicationUniqueNamePrefix(
        options.requirements.solution.name,
        resource.id,
      ),
      displayName: `${options.requirements.solution.name} ${resource.id} API`,
      delegatedPermissionScope:
        authentication.delegatedPermissionScope ?? "access_as_user",
      authorizedClientApplicationIds:
        authentication.authorizedClientApplicationIds,
      callerApplications,
      callerPrincipalOutputs: [...callerPrincipalOutputs],
    }];
  });
}

function entraCallerPrincipalOutputs(
  options: ProvisioningSourceOptions,
  target: ResourceRequirement,
): string[] {
  const resources = options.requirements.resources;
  const principals = new Set<string>();
  const targetOutputs = new Set(target.produces ?? []);
  const ingress = asObject(asObject(target.configuration).ingress);
  const privateEndpoint = asObject(ingress.privateEndpoint);
  const authentication = asObject(
    asObject(target.configuration).authentication,
  );
  const allowedSources = new Set([
    ...arrayValue(authentication.callerResources),
    ...arrayValue(
      privateEndpoint.sourceResources ?? ingress.allowedSourceResources,
    ),
  ].filter((value): value is string => typeof value === "string"));
  for (const sourceId of allowedSources) {
    const source = resources.find((resource) => resource.id === sourceId);
    if (!source) continue;
    const configuredIdentity = exactOutputBinding(
      asObject(source.configuration).identityResourceId,
    );
    const identityOutput = configuredIdentity ??
      source.produces?.find((output) => /IdentityResourceId$/.test(output));
    const principal = identityOutput
      ? principalOutputForIdentity(resources, identityOutput)
      : source.produces?.find((output) => /IdentityPrincipalId$/.test(output));
    if (principal) principals.add(principal);
  }
  for (const workflow of resources.filter(
    (resource) => resource.kind === "workflow-host",
  )) {
    const bindings = outputBindings(workflow.parameters);
    if (!bindings.some((binding) => targetOutputs.has(binding))) continue;
    for (const identityOutput of bindings.filter((binding) =>
      /IdentityResourceId$/.test(binding)
    )) {
      const principal = principalOutputForIdentity(resources, identityOutput);
      if (principal) principals.add(principal);
    }
  }
  return [...principals];
}

function principalOutputForIdentity(
  resources: readonly ResourceRequirement[],
  identityOutput: string,
): string | undefined {
  const producer = resources.find((resource) =>
    resource.produces?.includes(identityOutput)
  );
  if (!producer) return undefined;
  const expected = identityOutput.replace(/ResourceId$/, "PrincipalId");
  return producer.produces?.includes(expected)
    ? expected
    : producer.produces?.find((output) => /IdentityPrincipalId$/.test(output));
}

function exactOutputBinding(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
}

export function entraOutput(resourceId: string, suffix: string): string {
  return `DEPLOY_ENTRA_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

export function microsoftEntraAuthentication(
  resource: ResourceRequirement,
):
  | {
      delegatedPermissionScope?: string;
      authorizedClientApplicationIds: readonly string[];
      callerApplicationIds: readonly string[];
      authorizeDeploymentPrincipal: boolean;
    }
  | undefined {
  if (
    resource.authentication !== "managed-identity" &&
    resource.authentication !== "microsoft-entra"
  ) {
    return undefined;
  }
  const authentication = asObject(
    asObject(resource.configuration).authentication,
  );
  if (
    resource.authentication === "managed-identity" &&
    Object.keys(authentication).length === 0
  ) {
    return {
      authorizedClientApplicationIds: [],
      callerApplicationIds: [],
      authorizeDeploymentPrincipal: false,
    };
  }
  const provider = requiredString(
    authentication.provider,
    `${resource.id}.configuration.authentication.provider`,
  );
  if (provider !== "microsoft-entra") {
    throw new Error(
      `${resource.id}.configuration.authentication.provider must be 'microsoft-entra'.`,
    );
  }
  return {
    delegatedPermissionScope: requiredString(
      authentication.delegatedPermissionScope,
      `${resource.id}.configuration.authentication.delegatedPermissionScope`,
    ),
    authorizedClientApplicationIds: requiredArray(
      authentication.authorizedClientApplicationIds,
      `${resource.id}.configuration.authentication.authorizedClientApplicationIds`,
    ).map((applicationId, index) =>
      requiredString(
        applicationId,
        `${resource.id}.configuration.authentication.authorizedClientApplicationIds[${index}]`,
      )
    ),
    callerApplicationIds: arrayValue(
      authentication.callerApplicationIds,
    ).map((applicationId, index) =>
      requiredString(
        applicationId,
        `${resource.id}.configuration.authentication.callerApplicationIds[${index}]`,
      )
    ),
    authorizeDeploymentPrincipal: optionalBoolean(
      authentication.authorizeDeploymentPrincipal,
      `${resource.id}.configuration.authentication.authorizeDeploymentPrincipal`,
      false,
    ),
  };
}