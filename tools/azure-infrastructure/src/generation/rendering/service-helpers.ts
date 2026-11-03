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
  needsAuthorization = false,
): Promise<ReadonlyMap<string, string>> {
  const helpers = new Set<string>();
  const hostedComponents = solution.components.filter(
    (component) => component.kind === "hosted-agent",
  );
  if (hostedComponents.length > 0) helpers.add("hosted-agent");
  if (requirements.resources.some((resource) =>
    resource.kind === "configuration-store" &&
    hostedComponents.some((component) => resource.requiredBy.includes(component.id))
  )) {
    helpers.add("app-configuration");
  }
  if (needsAuthorization) helpers.add("authorization");
  if (requirements.resources.some((resource) => resource.kind === "teams-application")) {
    helpers.add("teams");
  }
  if (requirements.resources.some((resource) => resource.kind === "workflow-host")) {
    helpers.add("workflows");
    helpers.add("api-connections");
    helpers.add("values");
  }
  if (requirements.resources.some(
    (resource) => resource.kind === "authorized-api-connection",
  )) {
    helpers.add("connections");
    helpers.add("api-connections");
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
