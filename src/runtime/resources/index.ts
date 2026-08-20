export {
  prepareAuthorizedConnection,
  prepareResourceRequirements,
  type AuthorizedConnectionOptions,
} from "./connections.js";
export { deployResourceComponent } from "./component.js";
export {
  appConfigurationKeySetArgs,
  createHostedAgentManifest,
  deployHostedAgentService,
  parseHostedAgentVersion,
  type HostedAgentAccess,
  type HostedAgentDeploymentOptions,
} from "./hosted-agent.js";
export {
  provisionTeamsApplication,
  teamsEnvironmentName,
  type TeamsApplicationDeploymentOptions,
} from "./teams.js";
export type { DeployResourceComponentOptions } from "./types.js";
export { resolveOutputBindings } from "./values.js";
export {
  enableWorkflowDeployment,
  type WorkflowDeploymentOptions,
} from "./workflows.js";