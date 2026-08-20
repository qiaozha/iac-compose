export {
  ensureDeploymentPrincipalRoles,
  validateResourceRequirements,
} from "./azure.js";
export { planResourceValidation } from "./plan.js";
export type {
  DeploymentRoleRequirement,
  DeploymentRoleValidation,
  ResourceProviderValidation,
  ResourceRequirementsValidationResult,
  ResourceValidationPlan,
  ValidateResourceRequirementsOptions,
} from "./types.js";