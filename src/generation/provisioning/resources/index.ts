import { ownerNeedsProvisioning } from "../ownership.js";
import type { ProvisioningSourceOptions } from "../types.js";
import { RenderingContext } from "./context.js";
import { renderProvisioningDocument } from "./document.js";
import {
  renderAccess,
  renderConfigurationValues,
} from "./emitters/access.js";
import {
  renderBots,
  renderConnections,
  renderContainers,
} from "./emitters/applications.js";
import {
  renderAiProjects,
  renderBotIdentities,
  renderConfigurationStores,
  renderDocumentDatabases,
  renderModelDeployments,
  renderMonitoring,
  renderObjectStorage,
  renderRegistry,
} from "./emitters/infrastructure.js";
import { renderWorkflows } from "./emitters/workflows.js";
import { prepareWorkflowPlans, registerOutputs } from "./plan.js";

export function renderProvisioningSource(
  options: ProvisioningSourceOptions,
): string {
  if (options.requirements.resources.length === 0) {
    return `export const solutionName = ${JSON.stringify(options.requirements.solution.name)};

export const outputBicep = [
  { path: "main.bicep", contents: "targetScope = 'resourceGroup'\\n" },
  { path: "main.bicepparam", contents: "using './main.bicep'\\n" },
];
`;
  }
  return renderOwnerProvisioningSource(options);
}

export function renderProvisioningSources(
  options: ProvisioningSourceOptions,
): ReadonlyMap<string, string> {
  if (options.requirements.resources.length === 0) {
    return new Map([["shared", renderProvisioningSource(options)]]);
  }
  const sources = new Map<string, string>();
  for (const owner of ["shared", ...options.orderedComponents]) {
    if (!ownerNeedsProvisioning(options, owner)) continue;
    sources.set(owner, renderOwnerProvisioningSource(options, owner));
  }
  return sources;
}

function renderOwnerProvisioningSource(
  options: ProvisioningSourceOptions,
  owner?: string,
): string {
  const context = new RenderingContext(options, owner);
  registerOutputs(context);
  if (owner === undefined || owner === "shared") {
    context.outputs.set("DEPLOY_RESOURCE_SUFFIX", "suffix");
  }
  prepareWorkflowPlans(context);

  renderRegistry(context);
  renderBotIdentities(context);
  renderAiProjects(context);
  renderModelDeployments(context);
  renderDocumentDatabases(context);
  renderObjectStorage(context);
  renderConfigurationStores(context);
  renderMonitoring(context);
  renderContainers(context);
  renderBots(context);
  renderConnections(context);
  renderWorkflows(context);
  renderConfigurationValues(context);
  renderAccess(context);

  return renderProvisioningDocument(context);
}