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
