import type {
  DeploymentSolution,
  ResourceRequirements,
} from "../../generation/contracts/deployment.js";
import type { DeploymentRoleRequirement } from "../../runtime/services/authorization.js";
export type {
  DeploymentRoleRequirement,
  EnsureDeploymentPrincipalRolesOptions,
} from "../../runtime/services/authorization.js";

export interface ResourceValidationPlan {
  readonly providers: readonly string[];
  readonly roles: readonly DeploymentRoleRequirement[];
}

export interface ValidateResourceRequirementsOptions {
  readonly requirements: ResourceRequirements;
  readonly solution?: DeploymentSolution;
  readonly subscriptionId?: string;
  readonly tenantId?: string;
  readonly principalId?: string;
  readonly principalType?: string;
  readonly scope?: string;
  readonly resourceGroup?: string;
  readonly grant?: boolean;
}

export interface ResourceProviderValidation {
  readonly namespace: string;
  readonly registrationState: string;
}

export interface DeploymentRoleValidation extends DeploymentRoleRequirement {
  readonly granted: boolean;
  readonly present: boolean;
}

export interface ResourceRequirementsValidationResult {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly scope: string;
  readonly providers: readonly ResourceProviderValidation[];
  readonly roles: readonly DeploymentRoleValidation[];
}
