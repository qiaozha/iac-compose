import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface LogicAppTeamsConfig {
  readonly teamsGroupId: string;
  readonly teamsChannelIds: readonly string[];
  readonly tenantId: string;
}

const configRoot = resolve(dirname(fileURLToPath(import.meta.url)), "config");

export async function loadLogicAppTeamsConfig(
  environment: string,
): Promise<LogicAppTeamsConfig> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(environment)) {
    throw new Error(`Invalid Logic App environment '${environment}'.`);
  }
  const path = resolve(configRoot, `${environment}.json`);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Logic App Teams config for environment '${environment}' was not found.`,
      );
    }
    throw error;
  }

  const value: unknown = JSON.parse(source);
  if (
    typeof value !== "object" ||
    value === null ||
    !("teamsGroupId" in value) ||
    typeof value.teamsGroupId !== "string" ||
    !("teamsChannelIds" in value) ||
    !Array.isArray(value.teamsChannelIds) ||
    !value.teamsChannelIds.every((channelId) => typeof channelId === "string") ||
    !("tenantId" in value) ||
    typeof value.tenantId !== "string"
  ) {
    throw new Error(`Logic App Teams config '${path}' is invalid.`);
  }
  return {
    teamsGroupId: value.teamsGroupId,
    teamsChannelIds: value.teamsChannelIds,
    tenantId: value.tenantId,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}