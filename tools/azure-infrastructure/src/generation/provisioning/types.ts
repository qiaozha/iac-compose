import type {
  DeploymentSolution,
  ResourceRequirements,
} from "../contracts/deployment.js";

export interface ProvisioningSourceOptions {
  requirements: ResourceRequirements;
  solution: DeploymentSolution;
  orderedComponents: readonly string[];
  templates: Readonly<Record<string, unknown>>;
  serviceManagementReference: string;
}