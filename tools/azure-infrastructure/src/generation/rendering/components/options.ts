import type { ResourceRequirement } from "../../contracts/deployment.js";

export interface ComponentSourceOptions {
  component: string;
  functionName: string;
  kind?: string | undefined;
  source?: string | undefined;
  resources: readonly ResourceRequirement[];
  allResources: readonly ResourceRequirement[];
  hasProvisioning: boolean;
  configureEntra: boolean;
}