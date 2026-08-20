import type { ResourceContractRequirement } from "../../shared/contracts/resources/types.js";

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

export function findComponentSource(
  resources: readonly ResourceContractRequirement[],
): string | undefined {
  return resources.find((resource) => resource.source)?.source;
}

export function resourceOutputName(resourceId: string, suffix: string): string {
  return `DEPLOY_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

export function resourceCreateEnvironmentName(resourceId: string): string {
  return `DEPLOY_CREATE_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

export function normalizeImageName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "application";
}

export function requiredProcessValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Required deployment value '${name}' is not configured.`);
  }
  return value;
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

export function asObject(
  value: unknown,
): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function resolveRuntimeSettings(
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