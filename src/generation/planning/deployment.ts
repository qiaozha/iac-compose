import type {
  DeploymentSolution,
  ResourceRequirement,
  ResourceRequirements,
} from "../contracts/deployment.js";

const outputBindingPattern = /\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g;

export function validateDeploymentContracts(
  requirements: ResourceRequirements,
  solution: DeploymentSolution,
): void {
  if (requirements.schemaVersion !== "1.0" || solution.schemaVersion !== "1.0") {
    throw new Error("Deployment generation supports schemaVersion '1.0'.");
  }
  const enabled = new Set(requirements.solution.enabledComponents);
  if (enabled.size !== requirements.solution.enabledComponents.length) {
    throw new Error("resource requirements contain duplicate enabled components.");
  }
  const solutionIds = solution.components.map((component) => component.id);
  if (new Set(solutionIds).size !== solutionIds.length) {
    throw new Error("solution contains duplicate component ids.");
  }
  for (const component of enabled) {
    if (!solutionIds.includes(component)) {
      throw new Error(`Enabled component '${component}' is missing from solution.json.`);
    }
  }
  for (const component of solutionIds) {
    if (!enabled.has(component)) {
      throw new Error(
        `Solution component '${component}' is not enabled by the resource requirements.`,
      );
    }
  }

  const resourceIds = new Set<string>();
  const resourcesById = new Map<string, ResourceRequirement>();
  const outputs = new Map<string, string>();
  for (const resource of requirements.resources) {
    if (resourceIds.has(resource.id)) {
      throw new Error(`Duplicate resource id '${resource.id}'.`);
    }
    resourceIds.add(resource.id);
    resourcesById.set(resource.id, resource);
    if (resource.requiredBy.length === 0) {
      throw new Error(`Resource '${resource.id}' must name at least one requiredBy component.`);
    }
    for (const component of resource.requiredBy) {
      if (!enabled.has(component)) {
        throw new Error(
          `Resource '${resource.id}' is required by unknown component '${component}'.`,
        );
      }
    }
    for (const output of resource.produces ?? []) {
      const existing = outputs.get(output);
      if (existing) {
        throw new Error(
          `Output '${output}' is produced by both '${existing}' and '${resource.id}'.`,
        );
      }
      outputs.set(output, resource.id);
    }
  }
  for (const target of requirements.resources) {
    const sourceIds = privateEndpointSourceResourceIds(target);
    if (sourceIds.length === 0) continue;
    if (target.kind !== "container-host") {
      throw new Error(
        `Resource '${target.id}' configures private endpoint sources but is not a container-host.`,
      );
    }
    const uniqueSourceIds = new Set<string>();
    for (const sourceId of sourceIds) {
      if (uniqueSourceIds.has(sourceId)) {
        throw new Error(
          `Resource '${target.id}' contains duplicate private endpoint source '${sourceId}'.`,
        );
      }
      uniqueSourceIds.add(sourceId);
      const source = resourcesById.get(sourceId);
      if (!source) {
        throw new Error(
          `Resource '${target.id}' references unknown private endpoint source '${sourceId}'.`,
        );
      }
      if (source === target) {
        throw new Error(
          `Resource '${target.id}' cannot use itself as a private endpoint source.`,
        );
      }
      if (source.kind !== "container-host") {
        throw new Error(
          `Private endpoint source '${sourceId}' for '${target.id}' is not a container-host.`,
        );
      }
    }
  }
  for (const target of requirements.resources) {
    const callerIds = authenticatedCallerResourceIds(target);
    const uniqueCallerIds = new Set<string>();
    for (const callerId of callerIds) {
      if (uniqueCallerIds.has(callerId)) {
        throw new Error(
          `Resource '${target.id}' contains duplicate authenticated caller '${callerId}'.`,
        );
      }
      uniqueCallerIds.add(callerId);
      const caller = resourcesById.get(callerId);
      if (!caller) {
        throw new Error(
          `Resource '${target.id}' references unknown authenticated caller '${callerId}'.`,
        );
      }
      if (caller === target) {
        throw new Error(
          `Resource '${target.id}' cannot authorize itself as a caller.`,
        );
      }
    }
  }
  for (const binding of collectOutputBindings(requirements.resources)) {
    if (!outputs.has(binding)) {
      throw new Error(`Output binding '${binding}' has no producing resource.`);
    }
  }

  const planned = solution.resources?.planned;
  if (planned) {
    const plannedById = new Map(planned.map((resource) => [resource.id, resource.kind]));
    for (const resource of requirements.resources) {
      const plannedKind = plannedById.get(resource.id);
      if (!plannedKind) {
        throw new Error(`Resource '${resource.id}' is missing from solution.resources.planned.`);
      }
      if (plannedKind !== resource.kind) {
        throw new Error(
          `Resource '${resource.id}' is '${resource.kind}' in requirements but '${plannedKind}' in solution.`,
        );
      }
    }
    for (const resource of planned) {
      if (!resourceIds.has(resource.id)) {
        throw new Error(
          `Planned resource '${resource.id}' is missing from the resource requirements.`,
        );
      }
    }
  }
}

export function orderDeploymentComponents(
  requirements: ResourceRequirements,
  solution: DeploymentSolution,
): string[] {
  const components = solution.components.map((component) => component.id);
  const sourceOrder = new Map(
    components.map((component, index) => [component, index]),
  );
  const componentKinds = new Map(
    solution.components.map((component) => [component.id, component.kind]),
  );
  const producers = new Map<string, ResourceRequirement>();
  for (const resource of requirements.resources) {
    for (const output of resource.produces ?? []) producers.set(output, resource);
  }
  const dependencies = new Map(
    components.map((component) => [component, new Set<string>()]),
  );
  for (const resource of requirements.resources) {
    const bindings = collectComponentBindings(resource);
    for (const binding of bindings) {
      const producer = producers.get(binding)!;
      if (producer.requiredBy.length !== 1) continue;
      const dependency = producer.requiredBy[0]!;
      for (const component of resource.requiredBy) {
        if (component !== dependency) dependencies.get(component)!.add(dependency);
      }
    }
  }
  const resourcesById = new Map(
    requirements.resources.map((resource) => [resource.id, resource]),
  );
  for (const target of requirements.resources) {
    for (const sourceId of privateEndpointSourceResourceIds(target)) {
      const source = resourcesById.get(sourceId)!;
      for (const sourceComponent of source.requiredBy) {
        for (const targetComponent of target.requiredBy) {
          if (sourceComponent !== targetComponent) {
            dependencies.get(sourceComponent)!.add(targetComponent);
          }
        }
      }
    }
  }

  const ordered: string[] = [];
  const remaining = new Set(components);
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((component) =>
        [...dependencies.get(component)!].every((dependency) =>
          ordered.includes(dependency),
        ),
      )
      .sort((left, right) => {
        const hostedDifference =
          Number(componentKinds.get(right) === "hosted-agent") -
          Number(componentKinds.get(left) === "hosted-agent");
        return hostedDifference || sourceOrder.get(left)! - sourceOrder.get(right)!;
      });
    if (ready.length === 0) {
      const cycle = [...remaining]
        .map(
          (component) =>
            `${component} -> ${[...dependencies.get(component)!]
              .filter((dependency) => remaining.has(dependency))
              .join(", ")}`,
        )
        .join("; ");
      throw new Error(`Component output bindings contain a dependency cycle: ${cycle}.`);
    }
    for (const component of ready) {
      remaining.delete(component);
      ordered.push(component);
    }
  }
  return ordered;
}

function collectComponentBindings(resource: ResourceRequirement): Set<string> {
  if (resource.kind === "container-host") {
    return collectOutputBindings(
      (resource.configuration as Record<string, unknown> | undefined)
        ?.runtimeSettings,
    );
  }
  if (resource.kind === "teams-application") {
    return collectOutputBindings(
      (resource.configuration as Record<string, unknown> | undefined)
        ?.manifestValues,
    );
  }
  if (resource.kind === "workflow-host") {
    return collectOutputBindings(resource.parameters);
  }
  return new Set();
}

function privateEndpointSourceResourceIds(
  resource: ResourceRequirement,
): readonly string[] {
  const ingress = asRecord(asRecord(resource.configuration).ingress);
  const privateEndpoint = asRecord(ingress.privateEndpoint);
  const sourceResources =
    privateEndpoint.sourceResources ?? ingress.allowedSourceResources;
  return sourceResources === undefined
    ? []
    : stringArray(
        sourceResources,
        `${resource.id}.configuration.ingress.privateEndpoint.sourceResources`,
      );
}

function authenticatedCallerResourceIds(
  resource: ResourceRequirement,
): readonly string[] {
  const authentication = asRecord(
    asRecord(resource.configuration).authentication,
  );
  return authentication.callerResources === undefined
    ? []
    : stringArray(
        authentication.callerResources,
        `${resource.id}.configuration.authentication.callerResources`,
      );
}

function collectOutputBindings(value: unknown): Set<string> {
  const bindings = new Set<string>();
  const source = JSON.stringify(value);
  if (source === undefined) return bindings;
  for (const match of source.matchAll(outputBindingPattern)) {
    if (match[1]) bindings.add(match[1]);
  }
  return bindings;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function requiredArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  return requiredArray(value, name).map((item, index) =>
    requiredString(item, `${name}[${index}]`),
  );
}