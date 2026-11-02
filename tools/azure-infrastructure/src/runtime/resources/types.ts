import type { ResourceContractRequirement } from "../../shared/contracts/resources/types.js";

export interface DeployResourceComponentOptions {
  component: string;
  kind?: string;
  packageDirectory: string;
  generatedDirectory: string;
  source?: string;
  resources: readonly ResourceContractRequirement[];
}