import { pascalCase, typescriptProperty } from "./names.js";
import type { ProvisioningSourceOptions } from "./types.js";
import { asObject, requiredArray, requiredObject } from "./values.js";

export function renderWorkflowDefinitionSources(
  options: ProvisioningSourceOptions,
): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const resource of options.requirements.resources) {
    if (resource.kind !== "workflow-host") continue;
    const template = requiredObject(
      options.templates[resource.id],
      `Workflow template '${resource.id}'`,
    );
    const templateResource = requiredArray(
      template.resources,
      `Workflow template '${resource.id}'.resources`,
    )[0];
    const definition = requiredObject(
      requiredObject(
        requiredObject(templateResource, `${resource.id}.resources[0]`).properties,
        `${resource.id}.resources[0].properties`,
      ).definition,
      `${resource.id}.definition`,
    );
    const functionName = `create${pascalCase(resource.id)}Definition`;
    const inputNames = collectWorkflowInputs(definition);
    const templateParameters = asObject(template.parameters);
    const interfaceName = `${pascalCase(resource.id)}Inputs`;
    const properties = inputNames
      .map((name) => {
        const parameter = asObject(templateParameters[name]);
        return `  ${typescriptProperty(name)}: ${workflowInputType(parameter.type)};`;
      })
      .join("\n");
    const body = renderWorkflowValue(definition, 1);
    const component = resource.requiredBy[0] ?? "workflow";
    files.set(
      `components/${component}/workflow.ts`,
      `import { fn, type ExpressionOrValue } from "@azure/provisioning-core";

export interface ${interfaceName} {
${properties}
}

export function ${functionName}(inputs: ${interfaceName}) {
  return ${body};
}
`,
    );
  }
  return files;
}

export function collectWorkflowInputs(value: unknown): string[] {
  const names = new Set<string>();
  const source = JSON.stringify(value);
  for (const match of source.matchAll(/parameters\\?\('([^']+)'\\?\)/g)) {
    if (match[1] && match[1] !== "$connections") names.add(match[1]);
  }
  return [...names];
}

function renderWorkflowValue(value: unknown, depth: number): string {
  if (typeof value === "string") {
    const parameter = /^\[parameters\('([^']+)'\)\]$/.exec(value);
    if (parameter) return `inputs.${typescriptProperty(parameter[1]!)}`;
    const concat = /^\[concat\(parameters\('([^']+)'\), '((?:[^']|'')*)'\)\]$/.exec(value);
    if (concat) {
      return `fn.concat(inputs.${typescriptProperty(concat[1]!)}, ${JSON.stringify(concat[2]!.replaceAll("''", "'"))})`;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return `[\n${value
      .map((item) => `${childIndent}${renderWorkflowValue(item, depth + 1)},`)
      .join("\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const indent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return `{\n${entries
      .map(
        ([key, item]) =>
          `${childIndent}${JSON.stringify(key)}: ${renderWorkflowValue(item, depth + 1)},`,
      )
      .join("\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function workflowInputType(type: unknown): string {
  switch (String(type ?? "string").toLowerCase()) {
    case "array":
      return "ExpressionOrValue<string[]>";
    case "bool":
    case "boolean":
      return "ExpressionOrValue<boolean>";
    case "int":
    case "integer":
      return "ExpressionOrValue<number>";
    case "object":
      return "Readonly<Record<string, unknown>>";
    default:
      return "ExpressionOrValue<string>";
  }
}