import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ResourceRequirement {
  id: string;
  kind: string;
  requiredBy: readonly string[];
  produces?: readonly string[];
  source?: string;
  [key: string]: unknown;
}

export interface ResourceRequirements {
  schemaVersion: string;
  solution: {
    name: string;
    enabledComponents: readonly string[];
  };
  resources: readonly ResourceRequirement[];
  outputBindings?: { syntax?: string };
}

export interface DeploymentSolution {
  schemaVersion: string;
  customer?: { name?: string; displayName?: string };
  components: readonly {
    id: string;
    name?: string;
    kind?: string;
    source?: string;
  }[];
  resources?: {
    contract?: string;
    planned?: readonly { id: string; kind: string }[];
  };
}

export async function loadResourceRequirements(
  path: string,
): Promise<ResourceRequirements> {
  const resolvedPath = resolve(path);
  return parseResourceRequirements(await readJson(resolvedPath), resolvedPath);
}

export async function loadDeploymentSolution(
  path: string,
): Promise<DeploymentSolution> {
  const resolvedPath = resolve(path);
  return parseDeploymentSolution(await readJson(resolvedPath), resolvedPath);
}

function parseResourceRequirements(
  value: unknown,
  path: string,
): ResourceRequirements {
  const object = requiredObject(value, path);
  const solution = requiredObject(object.solution, `${path}: solution`);
  const resources = requiredArray(object.resources, `${path}: resources`).map(
    (resource, index) => {
      const item = requiredObject(resource, `${path}: resources[${index}]`);
      return {
        ...item,
        id: requiredString(item.id, `${path}: resources[${index}].id`),
        kind: requiredString(item.kind, `${path}: resources[${index}].kind`),
        requiredBy: stringArray(
          item.requiredBy,
          `${path}: resources[${index}].requiredBy`,
        ),
        ...(item.produces === undefined
          ? {}
          : {
              produces: stringArray(
                item.produces,
                `${path}: resources[${index}].produces`,
              ),
            }),
        ...(item.source === undefined
          ? {}
          : {
              source: requiredString(
                item.source,
                `${path}: resources[${index}].source`,
              ),
            }),
      } satisfies ResourceRequirement;
    },
  );
  return {
    ...object,
    schemaVersion: requiredString(
      object.schemaVersion,
      `${path}: schemaVersion`,
    ),
    solution: {
      ...solution,
      name: requiredString(solution.name, `${path}: solution.name`),
      enabledComponents: stringArray(
        solution.enabledComponents,
        `${path}: solution.enabledComponents`,
      ),
    },
    resources,
  } as ResourceRequirements;
}

function parseDeploymentSolution(
  value: unknown,
  path: string,
): DeploymentSolution {
  const object = requiredObject(value, path);
  const components = requiredArray(object.components, `${path}: components`).map(
    (component, index) => {
      const item = requiredObject(component, `${path}: components[${index}]`);
      return {
        id: requiredString(item.id, `${path}: components[${index}].id`),
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.kind === "string" ? { kind: item.kind } : {}),
        ...(typeof item.source === "string" ? { source: item.source } : {}),
      };
    },
  );
  return {
    ...object,
    schemaVersion: requiredString(
      object.schemaVersion,
      `${path}: schemaVersion`,
    ),
    components,
  } as DeploymentSolution;
}

function requiredObject(value: unknown, name: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, any>;
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

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in '${path}': ${error.message}`);
    }
    throw error;
  }
}