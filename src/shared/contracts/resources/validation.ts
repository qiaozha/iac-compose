import type { ResourceContract } from "./types.js";

const supportedResourceKinds = new Set([
  "ai-project",
  "application-monitoring",
  "authorized-api-connection",
  "bot-identity",
  "configuration-store",
  "container-host",
  "document-database",
  "object-storage",
  "teams-application",
  "workflow-host",
]);

export function validateResourceContract(contract: ResourceContract): void {
  if (contract.schemaVersion !== "1.0") {
    throw new Error(
      `Resource contract schemaVersion '${contract.schemaVersion}' is unsupported.`,
    );
  }
  if (!contract.solution?.name) {
    throw new Error("Resource contract solution.name is required.");
  }
  if (!Array.isArray(contract.resources)) {
    throw new Error("Resource contract resources must be an array.");
  }
  const ids = new Set<string>();
  for (const resource of contract.resources) {
    if (!resource.id || !resource.kind || !Array.isArray(resource.requiredBy)) {
      throw new Error("Each resource requires id, kind, and requiredBy fields.");
    }
    if (ids.has(resource.id)) {
      throw new Error(`Duplicate resource id '${resource.id}'.`);
    }
    ids.add(resource.id);
    if (!supportedResourceKinds.has(resource.kind)) {
      throw new Error(`Unsupported resource kind '${resource.kind}'.`);
    }
  }
}