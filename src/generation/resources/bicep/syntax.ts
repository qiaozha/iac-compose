import type { ResourceContractRequirement } from "../../../shared/contracts/resources/types.js";

export function requiredOutputExpression(
  resource: ResourceContractRequirement,
  output: string,
  expressions: Readonly<Record<string, string>>,
): string {
  const expression = expressions[output];
  if (!expression) {
    throw new Error(
      `Resource '${resource.id}' of kind '${resource.kind}' cannot produce output '${output}'.`,
    );
  }
  return expression;
}

export function baseUrl(site: string): string {
  return `'https://\${${site}.properties.defaultHostName}'`;
}

export function azureName(
  solution: string,
  resource: string,
  maximumLength: number,
  hyphenated: boolean,
): string {
  const separator = hyphenated ? "-" : "";
  const normalized = `${solution}${separator}${resource}`
    .toLowerCase()
    .replace(hyphenated ? /[^a-z0-9-]+/g : /[^a-z0-9]+/g, hyphenated ? "-" : "")
    .replace(/^-+|-+$/g, "");
  const suffixLength = 6 + separator.length;
  const prefix = normalized.slice(0, Math.max(1, maximumLength - suffixLength));
  return `'${prefix}${separator}\${suffix}'`;
}

export function applicationAudience(solution: string, resource: string): string {
  const normalized = `${solution}-${resource}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return `'api://${normalized}-\${suffix}'`;
}

export function resourceOutputName(resourceId: string, suffix: string): string {
  return `DEPLOY_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

export function resourceCreateEnvironmentName(resourceId: string): string {
  return `DEPLOY_CREATE_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

export function bicepString(value: string): string {
  return `'${escapeBicepString(value)}'`;
}

export function escapeBicepString(value: string): string {
  return value.replaceAll("'", "''").replaceAll("${", "\\${");
}

export function bicepProperty(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : bicepString(value);
}

export function bicepIdentifier(value: string): string {
  const identifier = typescriptIdentifier(value);
  if (!identifier) {
    throw new Error(`Output '${value}' is not a valid Bicep identifier.`);
  }
  return identifier;
}

export function typescriptIdentifier(value: string): string {
  const identifier = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(identifier) ? identifier : `resource_${identifier}`;
}

export function uniqueSymbol(value: string, used: Set<string>): string {
  let candidate = value || "resource";
  let index = 2;
  while (used.has(candidate)) candidate = `${value}${index++}`;
  used.add(candidate);
  return candidate;
}

export function safeFileName(value: string): string {
  const name = value
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!name) {
    throw new Error(`Resource id '${value}' cannot be used as a file name.`);
  }
  return name;
}

export function asObject(value: unknown): Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, any>>)
    : {};
}

export function optionalArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

export function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}