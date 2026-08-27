import type { ResourceRequirement } from "../../contracts/deployment.js";
import {
  generatedProjectName,
  provisioningEntrypointName,
} from "../names.js";

const outputBindingPattern = /\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g;

export function componentProvisioningBlock(
  component: string,
  hasProvisioning: boolean,
  mergeOutputs = true,
  resources: readonly ResourceRequirement[] = [],
): string {
  if (!hasProvisioning) return "";
  const entrypoint = provisioningEntrypointName(component);
  const generatedProject = generatedProjectName(component);
  const ownsModelDeployment = resources.some(
    (resource) => resource.kind === "model-deployment",
  );
  const location = ownsModelDeployment
    ? "infrastructureLocation"
    : 'requiredEnv("AZURE_LOCATION")';
  const locationDeclaration = ownsModelDeployment
    ? `  const solutionLocation = requiredEnv("AZURE_LOCATION");
  const infrastructureLocation = process.env.AZURE_AI_LOCATION?.trim() || "eastus";
`
    : "";
  const locationOverride = ownsModelDeployment
    ? "      parameters: { location: infrastructureLocation },\n"
    : "";
  const persistedOutputs = ownsModelDeployment
    ? "persistedInfrastructureOutputs"
    : "infrastructureOutputs";
  const filterAiLocation = ownsModelDeployment
    ? `  const persistedInfrastructureOutputs = { ...infrastructureOutputs };
  delete persistedInfrastructureOutputs.AZURE_LOCATION;
`
    : "";
  return `${locationDeclaration}  const infrastructureOutputs = await deployment.provision(
    ${JSON.stringify(`${component} infrastructure`)},
    {
      entrypoint: ${entrypoint},
      outputDirectory: ${generatedProject},
      layer: ${JSON.stringify(component)},
      dependsOn: ["shared"],
      deploymentName: \`\${requiredEnv("AZURE_ENV_NAME")}-${escapeTemplateLiteral(component)}\`,
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: ${location},
${locationOverride}    },
  );
${filterAiLocation}  await deployment.deploy(${JSON.stringify(`persist ${component} infrastructure`)}, async () => {
    await persistEnvironment(
      deployment,
      ${persistedOutputs},
    );
  });
${mergeOutputs ? `  Object.assign(outputs, ${persistedOutputs});\n` : ""}`;
}

export function componentPathImports(
  component: string,
  hasProvisioning: boolean,
  includePackageRoot: boolean,
): string {
  return [
    ...(hasProvisioning ? [`  ${generatedProjectName(component)},`] : []),
    ...(includePackageRoot ? ["  generatedRoot,"] : []),
    ...(hasProvisioning ? [`  ${provisioningEntrypointName(component)},`] : []),
    ...(includePackageRoot ? ["  packageRoot,"] : []),
  ].join("\n");
}

export function renderRuntimeValue(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value);
  const exact = /^\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value);
  if (exact) return `deploymentValue(deployment, ${JSON.stringify(exact[1])})`;
  const parts: string[] = [];
  let offset = 0;
  for (const match of value.matchAll(outputBindingPattern)) {
    if (match.index! > offset) {
      parts.push(JSON.stringify(value.slice(offset, match.index)));
    }
    parts.push(`deploymentValue(deployment, ${JSON.stringify(match[1])})`);
    offset = match.index! + match[0].length;
  }
  if (parts.length === 0) return JSON.stringify(value);
  if (offset < value.length) parts.push(JSON.stringify(value.slice(offset)));
  return parts.join(" + ");
}

export function implementationOutputName(
  resourceId: string,
  suffix: string,
): string {
  return `DEPLOY_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

export function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

export function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value.map((item, index) =>
    requiredString(item, `${name}[${index}]`),
  );
}

export function escapeTemplateLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}