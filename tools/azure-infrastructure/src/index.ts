export {
  fetchAzureArchitectureCatalog,
  extractOfficialImplementationUrls,
  parseAzureArchitectureSource,
  writeAzureArchitectureCatalog,
  type ArchitectureImplementationMode,
  type ArchitectureImplementationRoute,
  type AzureArchitectureCatalog,
  type AzureArchitectureCatalogEntry,
  type FetchArchitectureCatalogOptions,
} from "./architecture-catalog.js";
export {
  generateDeploymentCode,
  loadResourceRequirements,
  type DeploymentCodeGenerationProgress,
  type DeploymentSolution,
  type GenerateDeploymentCodeOptions,
  type GenerateDeploymentCodeResult,
  type ResourceRequirement,
  type ResourceRequirements,
} from "./generator.js";
export {
  ensureDeploymentPrincipalRoles,
  planResourceValidation,
  validateResourceRequirements,
  type DeploymentRoleRequirement,
  type DeploymentRoleValidation,
  type ResourceProviderValidation,
  type ResourceRequirementsValidationResult,
  type ResourceValidationPlan,
  type ValidateResourceRequirementsOptions,
} from "./validation/resources/index.js";
export {
  renderResourceRequirements,
  type RenderedProvisioningFile,
  type RenderResourceRequirementsOptions,
  type ResourceContract,
  type ResourceContractRequirement,
} from "./generation/resources/index.js";
export { validateResourceContract } from "./shared/contracts/resources/validation.js";
export {
  deployResourceComponent,
  prepareResourceRequirements,
  resolveOutputBindings,
  type DeployResourceComponentOptions,
} from "./runtime/resources/index.js";
