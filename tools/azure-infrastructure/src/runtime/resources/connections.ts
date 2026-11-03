import type { Deployment } from "iac-composer";
import { prepareAuthorizedConnection } from "../services/connections.js";
import type { ResourceContract } from "../../shared/contracts/resources/types.js";

export async function prepareResourceRequirements(
  deployment: Deployment,
  contract: ResourceContract,
): Promise<void> {
  for (const resource of contract.resources) {
    if (
      resource.kind !== "authorized-api-connection" ||
      resource.authorization !== "interactive"
    ) {
      continue;
    }
    await prepareAuthorizedConnection(deployment, {
      resourceId: resource.id,
      name: "teams",
    });
  }
}