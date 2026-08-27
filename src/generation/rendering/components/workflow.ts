import {
  asRecord,
  componentPathImports,
  componentProvisioningBlock,
  implementationOutputName,
} from "./helpers.js";
import type { ComponentSourceOptions } from "./options.js";

export function renderWorkflowComponentSource(
  options: ComponentSourceOptions,
): string {
  const {
    component,
    functionName,
    resources,
    hasProvisioning,
    configureEntra,
  } = options;
  const workflows = resources.filter(
    (resource) => resource.kind === "workflow-host",
  );
  if (workflows.length !== 1) {
    throw new Error(
      `Workflow component '${component}' requires exactly one workflow-host resource; found ${workflows.length}.`,
    );
  }
  const workflow = workflows[0]!;
  const connections = resources.filter(
    (resource) => resource.kind === "authorized-api-connection",
  );
  if (connections.length > 1) {
    throw new Error(
      `Workflow component '${component}' supports at most one authorized-api-connection resource; found ${connections.length}.`,
    );
  }
  const parameters = asRecord(asRecord(workflow.parameters).parameters);
  const validationEntries = Object.entries(parameters)
    .filter(([, parameter]) => !hasOutputBinding(asRecord(parameter).value))
    .map(([name, parameter]) => {
      const value = asRecord(parameter).value;
      const environment = workflowEnvironmentName(workflow.id, name);
      if (Array.isArray(value)) {
        return `    ${JSON.stringify(name)}: (
      process.env[${JSON.stringify(environment)}] ?? ${JSON.stringify(value.join(","))}
    ).split(","),`;
      }
      return `    ${JSON.stringify(name)}:
      process.env[${JSON.stringify(environment)}] ?? ${JSON.stringify(value)},`;
    })
    .join("\n");
  const connection = connections[0];
  const connectionOutput = connection
    ? implementationOutputName(connection.id, "NAME")
    : undefined;
  const authorizationTenantId = connection
    ? asRecord(connection.configuration).tenantId
    : undefined;
  if (
    authorizationTenantId !== undefined &&
    (typeof authorizationTenantId !== "string" || !authorizationTenantId.trim())
  ) {
    throw new Error(
      `${connection!.id}.configuration.tenantId must be a non-empty string.`,
    );
  }
  const connectionPreparation = connection
    ? `  const connectionName =
    process.env[${JSON.stringify(connectionOutput)}]?.trim() || "teams";
  const connectionStatus = await prepareAuthorizedConnection(deployment, {
    resourceId: ${JSON.stringify(connection.id)},
    name: connectionName,
  });
  process.env[${JSON.stringify(workflowDeploymentEnvironmentName(workflow.id))}] =
    deployment.dryRun || connectionStatus === "Connected" ? "true" : "false";\n`
    : "";
  const pathImports = componentPathImports(component, hasProvisioning, false);
  const provisioning = componentProvisioningBlock(
    component,
    hasProvisioning,
    false,
    resources,
  );
  const entraConfigurationImport = configureEntra
    ? 'import { configureEntraApplications } from "../shared/identity.js";\n'
    : "";
  const entraConfigurationBlock = configureEntra
    ? "  await configureEntraApplications(deployment);\n"
    : "";
  return `import {
  enableWorkflowDeployment,
  prepareAuthorizedConnection,
  type Deployment,
} from "iac-compose";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
${entraConfigurationImport}import {
${pathImports}
} from "../../runtime/paths.js";

export async function ${functionName}(deployment: Deployment): Promise<void> {
${connectionPreparation}${provisioning}
${entraConfigurationBlock}  const validationValues = {
${validationEntries}
  };
  await enableWorkflowDeployment(deployment, {
    component: ${JSON.stringify(component)},
    workflowId: ${JSON.stringify(workflow.id)},
    workflowName: deploymentValue(
      deployment,
      ${JSON.stringify(implementationOutputName(workflow.id, "NAME"))},
    ),
    validationValues,
${connectionOutput ? `    connectionName: deploymentValue(
      deployment,
      ${JSON.stringify(connectionOutput)},
    ),\n` : ""}${authorizationTenantId ? `    authorizationTenantId: ${JSON.stringify(authorizationTenantId)},\n` : ""}
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "\${" + name + "}" : requiredEnv(name);
}
`;
}

function hasOutputBinding(value: unknown): boolean {
  return /\$\{output\.[A-Za-z][A-Za-z0-9_]*\}/.test(JSON.stringify(value));
}

function workflowEnvironmentName(resourceId: string, parameter: string): string {
  return `DEPLOY_WORKFLOW_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${parameter.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function workflowDeploymentEnvironmentName(resourceId: string): string {
  return `DEPLOY_WORKFLOW_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}