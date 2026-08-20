import type { ResourceContractRequirement } from "../../../shared/contracts/resources/types.js";
import {
  renderBotIdentity,
  renderContainerHost,
} from "./applications.js";
import type { BicepRenderContext } from "./context.js";
import {
  renderAiProject,
  renderApplicationMonitoring,
  renderConfigurationStore,
  renderDocumentDatabase,
  renderObjectStorage,
} from "./infrastructure.js";
import {
  renderAuthorizedConnection,
  renderWorkflow,
} from "./workflows.js";

export function renderResource(
  context: BicepRenderContext,
  resource: ResourceContractRequirement,
): void {
  switch (resource.kind) {
    case "ai-project":
      renderAiProject(context, resource);
      break;
    case "document-database":
      renderDocumentDatabase(context, resource);
      break;
    case "object-storage":
      renderObjectStorage(context, resource);
      break;
    case "configuration-store":
      renderConfigurationStore(context, resource);
      break;
    case "application-monitoring":
      renderApplicationMonitoring(context, resource);
      break;
    case "container-host":
      renderContainerHost(context, resource);
      break;
    case "bot-identity":
      renderBotIdentity(context, resource);
      break;
    case "teams-application":
      break;
    case "authorized-api-connection":
      renderAuthorizedConnection(context, resource);
      break;
    case "workflow-host":
      renderWorkflow(context, resource);
      break;
    default:
      throw new Error(`Unsupported resource kind '${resource.kind}'.`);
  }
}