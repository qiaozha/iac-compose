import { resolve } from "node:path";
import type { Deployment } from "iac-composer";
import { provisionTeamsApplication } from "../services/teams.js";
import type { ResourceContractRequirement } from "../../shared/contracts/resources/types.js";
import type { DeployResourceComponentOptions } from "./types.js";
import { asObject, findComponentSource, requiredString, resolveOutputBindings } from "./values.js";

export async function deployTeamsApplicationResource(
  deployment: Deployment,
  options: DeployResourceComponentOptions,
  resource: ResourceContractRequirement,
): Promise<Record<string, string>> {
  const source = options.source ?? findComponentSource(options.resources);
  if (!source) {
    throw new Error(
      `Teams application '${resource.id}' requires a component source directory.`,
    );
  }
  const configuration = asObject(resource.configuration);
  const manifestValues = asObject(configuration.manifestValues);
  return provisionTeamsApplication(deployment, {
    component: options.component,
    componentDirectory: resolve(options.packageDirectory, source),
    manifestValues: Object.fromEntries(
      Object.entries(manifestValues)
        .filter(([name]) => name !== "TEAMS_APP_ID")
        .map(([name, value]) => [
          name,
          resolveOutputBindings(
            requiredString(
              value,
              `${resource.id}.configuration.manifestValues.${name}`,
            ),
          ),
        ]),
    ),
    outputNames: resource.produces,
  });
}
