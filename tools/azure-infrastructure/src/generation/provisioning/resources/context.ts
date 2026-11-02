import type { ResourceRequirement } from "../../contracts/deployment.js";
import { identifier, pascalCase } from "../names.js";
import { implementationOutput } from "../outputs.js";
import { resourceOwner } from "../ownership.js";
import type { ProvisioningSourceOptions } from "../types.js";
import { outputBindings } from "../outputs.js";
import { accessValues } from "./helpers.js";

export interface WorkflowPlan {
  resource: ResourceRequirement;
  definition: Readonly<Record<string, unknown>>;
  templateParameters: Readonly<Record<string, unknown>>;
  functionName: string;
  importPath: string;
  deploymentCondition?: string;
  parameterExpressions: ReadonlyMap<string, string>;
  parameterDeclarations: readonly string[];
  parameterBindings: readonly string[];
}

export class RenderingContext {
  readonly resources: readonly ResourceRequirement[];
  readonly componentKinds: ReadonlyMap<string, string | undefined>;
  readonly outputs = new Map<string, string>();
  readonly externalOutputs = new Map<string, string>();
  readonly sections: string[] = [];
  readonly graphResources: string[] = [];
  readonly parameters: string[] = [];
  readonly parameterBindings: string[] = [];
  readonly inputParameters = new Map<string, string>();
  readonly existingResources = new Set<string>();
  readonly workflowPlans: WorkflowPlan[] = [];

  constructor(
    readonly options: ProvisioningSourceOptions,
    readonly owner?: string,
  ) {
    this.resources = options.requirements.resources;
    this.componentKinds = new Map(
      options.solution.components.map((component) => [component.id, component.kind]),
    );
  }

  addSection(source: string): void {
    this.sections.push(source);
  }

  solutionName(): string {
    return this.options.requirements.solution.name;
  }

  owns(resource: ResourceRequirement): boolean {
    return this.owner === undefined || resourceOwner(resource) === this.owner;
  }

  ofKind(kind: string): ResourceRequirement[] {
    return this.resources.filter(
      (resource) => resource.kind === kind && this.owns(resource),
    );
  }

  isHosted(resource: ResourceRequirement): boolean {
    return (
      resource.kind === "container-host" &&
      resource.requiredBy.some(
        (component) => this.componentKinds.get(component) === "hosted-agent",
      )
    );
  }

  hasHostedAgent(): boolean {
    return this.resources.some((resource) => this.isHosted(resource));
  }

  hasRegistry(): boolean {
    return this.resources.some((resource) => resource.kind === "container-host");
  }

  hasExplicitRegistryAccess(principal: ResourceRequirement): boolean {
    const principalOutputs = new Set(principal.produces ?? []);
    return this.resources.some(
      (resource) =>
        resource.kind === "container-registry" &&
        accessValues(resource).some(
          (grant) =>
            grant.role === "AcrPull" && principalOutputs.has(grant.principalOutput),
        ),
    );
  }

  input(environmentName: string, hint = environmentName, fallback?: string): string {
    const existing = this.inputParameters.get(environmentName);
    if (existing) return existing;
    const variable = `input${pascalCase(hint)}`;
    this.inputParameters.set(environmentName, variable);
    this.parameters.push(
      `const ${variable} = stack.parameters.add(${JSON.stringify(variable)}, "string");`,
    );
    this.parameterBindings.push(
      `${variable}: fn.readEnvironmentVariable(${JSON.stringify(environmentName)}${fallback === undefined ? "" : `, ${JSON.stringify(fallback)}`})`,
    );
    return variable;
  }

  externalOutput(name: string): string {
    const existing = this.externalOutputs.get(name);
    if (existing) return existing;
    const producer = this.resources.find((resource) =>
      resource.produces?.includes(name),
    );
    if (!producer) throw new Error(`Output '${name}' is unavailable.`);
    const expression = this.input(name, name);
    this.externalOutputs.set(name, expression);
    return expression;
  }

  renderValue(value: unknown): string {
    if (typeof value === "string") {
      const exact = /^\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value);
      if (exact) {
        return this.outputs.get(exact[1]!) ?? this.externalOutput(exact[1]!);
      }
      const parts: string[] = [];
      let offset = 0;
      for (const match of value.matchAll(/\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g)) {
        if (match.index! > offset) {
          parts.push(JSON.stringify(value.slice(offset, match.index)));
        }
        parts.push(
          this.outputs.get(match[1]!) ?? this.externalOutput(match[1]!),
        );
        offset = match.index! + match[0].length;
      }
      if (parts.length === 0) return JSON.stringify(value);
      if (offset < value.length) parts.push(JSON.stringify(value.slice(offset)));
      return `fn.concat(${parts.join(", ")})`;
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.renderValue(item)).join(", ")}]`;
    }
    if (typeof value === "object" && value !== null) {
      return `{ ${Object.entries(value)
        .map(([key, item]) => `${JSON.stringify(key)}: ${this.renderValue(item)}`)
        .join(", ")} }`;
    }
    return JSON.stringify(value);
  }

  scopeExpression(resource: ResourceRequirement): string {
    if (resource.kind === "container-registry") return "deploymentRegistry";
    if (!this.owns(resource)) this.ensureExistingResource(resource);
    const base = identifier(resource.id);
    const scopes: Readonly<Record<string, string>> = {
      "ai-project": `${base}Project`,
      "document-database": `${base}Account`,
      "object-storage": `${base}Account`,
      "configuration-store": `${base}Store`,
      "application-monitoring": `${base}Insights`,
      "container-host": `${base}Site`,
      "bot-identity": `${base}Identity`,
    };
    const scope = scopes[resource.kind];
    if (!scope) throw new Error(`Resource '${resource.id}' cannot own access grants.`);
    return scope;
  }

  ensureExistingResource(resource: ResourceRequirement): void {
    if (this.owns(resource) || this.existingResources.has(resource.id)) return;
    this.existingResources.add(resource.id);
    const base = identifier(resource.id);
    switch (resource.kind) {
      case "ai-project": {
        const accountName = this.input("AI_RESOURCE_NAME");
        const projectName = this.input("AI_PROJECT_NAME");
        this.addSection(`const ${base}Account = new Account(stack, {
  name: ${accountName},
  existing: true,
});

const ${base}Project = new Project(${base}Account, {
  name: ${projectName},
  existing: true,
});
`);
        return;
      }
      case "configuration-store": {
        const name = this.input(implementationOutput(resource.id, "NAME"));
        this.addSection(`const ${base}Store = new ConfigurationStore(stack, {
  name: ${name},
  existing: true,
});
`);
        return;
      }
      case "document-database": {
        const name = this.input(implementationOutput(resource.id, "NAME"));
        this.addSection(`const ${base}Account = new DatabaseAccount(stack, {
  name: ${name},
  existing: true,
});
`);
        return;
      }
      case "object-storage": {
        const name = this.input(implementationOutput(resource.id, "NAME"));
        this.addSection(`const ${base}Account = new StorageAccount(stack, {
  name: ${name},
  existing: true,
});
`);
        return;
      }
      case "application-monitoring": {
        const name = this.input(implementationOutput(resource.id, "NAME"));
        this.addSection(`const ${base}Insights = new ApplicationInsightsComponent(stack, {
  name: ${name},
  existing: true,
});
`);
        return;
      }
      default:
        throw new Error(
          `Resource '${resource.id}' of kind '${resource.kind}' cannot be referenced from '${this.owner}'.`,
        );
    }
  }

  principalKey(resource: ResourceRequirement): string {
    const base = identifier(resource.id);
    if (resource.kind === "container-host") return `${base}Identity.id`;
    if (resource.kind === "bot-identity") return `${base}Identity.id`;
    throw new Error(`Resource '${resource.id}' cannot produce a principal.`);
  }

  workflowDeploymentCondition(
    workflow: ResourceRequirement,
  ): string | undefined {
    const owner = resourceOwner(workflow);
    const hasInteractiveConnection = this.resources.some(
      (resource) =>
        resource.kind === "authorized-api-connection" &&
        resource.authorization === "interactive" &&
        resourceOwner(resource) === owner,
    );
    return hasInteractiveConnection
      ? `deploy${pascalCase(workflow.id)}`
      : undefined;
  }

  effectiveOwner(): string {
    return this.owner ?? "all";
  }

  configurationValueOwner(value: unknown): string | undefined {
    const bindings = outputBindings(value);
    if (bindings.some((binding) => binding === "agentVersion") && this.hasHostedAgent()) {
      return undefined;
    }
    if (this.owner === undefined) return "all";
    if (bindings.length === 0) return "shared";
    const owners = bindings.map((binding) => {
      const producer = this.resources.find((resource) =>
        resource.produces?.includes(binding),
      );
      if (!producer) throw new Error(`Output '${binding}' is unavailable.`);
      if (this.isHosted(producer)) return undefined;
      return resourceOwner(producer);
    });
    if (owners.some((owner) => owner === undefined)) return undefined;
    const resolvedOwners = owners.filter(
      (owner): owner is string => owner !== undefined,
    );
    const order = ["shared", ...this.options.orderedComponents];
    return resolvedOwners.reduce((latest, owner) =>
      order.indexOf(owner!) > order.indexOf(latest) ? owner! : latest,
    "shared");
  }
}