import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type EnvironmentValues = Record<string, string>;

export function requiredEnv(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment[name]?.trim();
  if (!value || value.startsWith("REPLACE_WITH_")) {
    throw new Error(`Required deployment value '${name}' is not configured.`);
  }
  return value;
}

export function optionalEnv(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return environment[name]?.trim() || undefined;
}

export function stringEnvironment(
  environment: NodeJS.ProcessEnv,
): EnvironmentValues {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export async function readEnvironmentFile(
  path: string,
): Promise<EnvironmentValues> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Object.values(parsed).every((value) => typeof value === "string")
    ) {
      throw new Error(`Environment file '${path}' must contain string values.`);
    }
    return parsed as EnvironmentValues;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function persistEnvironmentFile(
  path: string,
  values: EnvironmentValues,
): Promise<EnvironmentValues> {
  const merged = sortEnvironment({
    ...(await readEnvironmentFile(path)),
    ...values,
  });
  Object.assign(process.env, values);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(merged, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporaryPath, path);
  return merged;
}

function sortEnvironment(values: EnvironmentValues): EnvironmentValues {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}