import type {
  RenderResourceRequirementsOptions,
  ResourceContract,
  ResourceContractRequirement,
} from "../../../shared/contracts/resources/types.js";
import {
  hasHostedAgentResource,
  isHostedAgentResource,
  planBicepResources,
  type ResourceSymbols,
} from "./plan.js";
import {
  asObject,
  bicepIdentifier,
  bicepString,
  escapeBicepString,
} from "./syntax.js";

export class BicepRenderContext {
  readonly contract: ResourceContract;
  readonly options: RenderResourceRequirementsOptions;
  readonly symbols: Map<string, ResourceSymbols>;
  readonly outputs: Map<string, string>;
  readonly sections: string[] = [];
  readonly implementationOutputs = new Map<string, string>();
  #roleAssignmentIndex = 0;

  constructor(
    contract: ResourceContract,
    options: RenderResourceRequirementsOptions,
  ) {
    this.contract = contract;
    this.options = options;
    const plan = planBicepResources(contract, options);
    this.symbols = plan.symbols;
    this.outputs = plan.outputs;
  }

  isHostedAgent(resource: ResourceContractRequirement): boolean {
    return isHostedAgentResource(resource, this.options);
  }

  hasHostedAgent(): boolean {
    return hasHostedAgentResource(this.contract, this.options);
  }

  containsDeferredOutput(value: unknown): boolean {
    if (!this.hasHostedAgent()) return false;
    const source = JSON.stringify(value);
    if (!source) return false;
    return [...source.matchAll(/\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g)].some(
      (match) => match[1] === "agentVersion",
    );
  }

  interactiveConnections(): readonly ResourceContractRequirement[] {
    return this.contract.resources.filter(
      (resource) =>
        resource.kind === "authorized-api-connection" &&
        resource.authorization === "interactive",
    );
  }

  connectionCreateParameter(resource: ResourceContractRequirement): string {
    const symbol = this.symbols.get(resource.id)!.main!;
    return `create${symbol.charAt(0).toUpperCase()}${symbol.slice(1)}`;
  }

  nextRoleAssignmentIndex(): number {
    this.#roleAssignmentIndex += 1;
    return this.#roleAssignmentIndex;
  }

  renderOutputs(): void {
    for (const [name, expression] of this.outputs) {
      this.sections.push(
        "",
        `output ${bicepIdentifier(name)} string = ${expression}`,
      );
    }
    for (const [name, expression] of this.implementationOutputs) {
      if (this.outputs.has(name)) continue;
      this.sections.push("", `output ${name} string = ${expression}`);
    }
  }

  renderValue(value: unknown): string {
    if (typeof value === "string") return this.renderString(value);
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (value === null) return "null";
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.renderValue(item)).join(", ")}]`;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      return `{ ${entries
        .map(([key, item]) => `${this.renderObjectKey(key)}: ${this.renderValue(item)}`)
        .join(", ")} }`;
    }
    throw new Error(`Cannot render resource value of type '${typeof value}'.`);
  }

  renderParameterValue(value: unknown): string {
    const object = asObject(value);
    if (typeof object.expression === "string") return object.expression;
    return this.renderValue(value);
  }

  renderString(value: string): string {
    const matches = [
      ...value.matchAll(/\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g),
    ];
    if (matches.length === 0) return bicepString(value);
    if (matches.length === 1 && matches[0]![0] === value) {
      return this.requiredBinding(matches[0]![1]!);
    }
    let rendered = "";
    let offset = 0;
    for (const match of matches) {
      rendered += escapeBicepString(value.slice(offset, match.index));
      rendered += `\${${this.requiredBinding(match[1]!)}}`;
      offset = match.index! + match[0].length;
    }
    rendered += escapeBicepString(value.slice(offset));
    return `'${rendered}'`;
  }

  renderObjectKey(value: string): string {
    const match = /^\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value);
    if (match) return `'\${${this.requiredBinding(match[1]!)}}'`;
    return this.renderString(value);
  }

  requiredBinding(name: string): string {
    const expression = this.outputs.get(name);
    if (!expression) {
      throw new Error(`Output binding '${name}' has no producing resource.`);
    }
    return expression;
  }
}