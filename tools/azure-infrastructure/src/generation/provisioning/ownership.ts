import type { ResourceRequirement } from "../contracts/deployment.js";
import { outputBindings } from "./outputs.js";
import type { ProvisioningSourceOptions } from "./types.js";
import { asObject } from "./values.js";

export function resourceOwner(resource: ResourceRequirement): string {
  return resource.requiredBy.length === 1
    ? resource.requiredBy[0]!
    : "shared";
}

export function ownerNeedsProvisioning(
  options: ProvisioningSourceOptions,
  owner: string,
): boolean {
  if (owner === "shared" && options.requirements.resources.length > 0) return true;
  const componentKinds = new Map(
    options.solution.components.map((component) => [component.id, component.kind]),
  );
  const ownsInfrastructure = options.requirements.resources.some((resource) => {
    if (resourceOwner(resource) !== owner) return false;
    if (resource.kind === "teams-application") return false;
    if (
      resource.kind === "container-host" &&
      resource.requiredBy.some(
        (component) => componentKinds.get(component) === "hosted-agent",
      )
    ) {
      return false;
    }
    return true;
  });
  if (ownsInfrastructure) return true;
  return options.requirements.resources
    .filter((resource) => resource.kind === "configuration-store")
    .some((resource) =>
      Object.values(asObject(asObject(resource.configuration).values)).some(
        (value) => configurationValueOwner(options, value) === owner,
      ),
    );
}

function configurationValueOwner(
  options: ProvisioningSourceOptions,
  value: unknown,
): string | undefined {
  const bindings = outputBindings(value);
  const componentKinds = new Map(
    options.solution.components.map((component) => [component.id, component.kind]),
  );
  if (bindings.length === 0) return "shared";
  const owners = bindings.map((binding) => {
    const producer = options.requirements.resources.find((resource) =>
      resource.produces?.includes(binding),
    );
    if (!producer) throw new Error(`Output '${binding}' is unavailable.`);
    if (
      producer.kind === "container-host" &&
      producer.requiredBy.some(
        (component) => componentKinds.get(component) === "hosted-agent",
      )
    ) {
      return undefined;
    }
    if (binding === "agentVersion" && componentKinds.has("agent")) {
      return undefined;
    }
    return resourceOwner(producer);
  });
  if (owners.some((owner) => owner === undefined)) return undefined;
  const resolvedOwners = owners.filter(
    (owner): owner is string => owner !== undefined,
  );
  const order = ["shared", ...options.orderedComponents];
  return resolvedOwners.reduce(
    (latest, owner) =>
      order.indexOf(owner!) > order.indexOf(latest) ? owner! : latest,
    "shared",
  );
}