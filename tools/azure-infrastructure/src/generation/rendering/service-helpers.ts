import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  DeploymentSolution,
  ResourceRequirements,
} from "../contracts/deployment.js";

export async function loadServiceHelperSources(
  packageDirectory: string,
  requirements: ResourceRequirements,
  solution: DeploymentSolution,
): Promise<ReadonlyMap<string, string>> {
  const helpers = new Set<string>();
  if (solution.components.some((component) => component.kind === "hosted-agent")) {
    helpers.add("hosted-agent");
    helpers.add("values");
  }
  if (requirements.resources.some((resource) => resource.kind === "teams-application")) {
    helpers.add("teams");
  }
  if (requirements.resources.some((resource) => resource.kind === "workflow-host")) {
    helpers.add("workflows");
    helpers.add("values");
  }
  if (requirements.resources.some(
    (resource) => resource.kind === "authorized-api-connection",
  )) {
    helpers.add("connections");
    helpers.add("values");
  }
  const sources = await Promise.all(
    [...helpers].sort().map(async (name): Promise<[string, string]> => [
      `runtime/services/${name}.ts`,
      await readFile(
        resolve(packageDirectory, "src/runtime/services", `${name}.ts`),
        "utf8",
      ),
    ]),
  );
  return new Map(sources);
}
