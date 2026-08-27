import { sep } from "node:path";

import {
  generatedProjectName,
  provisioningEntrypointName,
} from "./names.js";

export function renderDeploymentSource(
  components: readonly string[],
  names: ReadonlyMap<string, string>,
  solutionName: string,
): string {
  const imports = [
    'import { defineDeployment, type Deployment } from "imperative-deploy";',
    ...components.map(
      (component) =>
        `import { ${names.get(component)} } from "./components/${component}/index.js";`,
    ),
    'import { shared } from "./components/shared/index.js";',
    'import { prepareEnvironment } from "./runtime/environment.js";',
  ].join("\n");
  const entries = components
    .map((component) => `  ${JSON.stringify(component)}: ${names.get(component)},`)
    .join("\n");
  const steps = components
    .map((component) => `  await ${names.get(component)}(deployment);`)
    .join("\n");
  return `${imports}

const componentDeployments: Record<
  string,
  (deployment: Deployment) => Promise<void>
> = {
  shared,
${entries}
};

export default defineDeployment(async (deployment) => {
  await prepareEnvironment(deployment);
  if (deployment.component) {
    const deployComponent = componentDeployments[deployment.component];
    if (!deployComponent) {
      throw new Error(
        \`Unknown ${escapeTemplateLiteral(solutionName)} component '\${deployment.component}'. Expected one of: \${Object.keys(componentDeployments).join(", ")}.\`,
      );
    }
    await deployComponent(deployment);
    return;
  }
  await shared(deployment);
${steps}
});
`;
}

export function renderRuntimePathsSource(
  packagePath: string,
  owners: readonly string[],
  provisioningOwners: readonly string[],
  hasEntra: boolean,
): string {
  const generatedProjects = owners
    .map(
      (owner) =>
        `export const ${generatedProjectName(owner)} = resolve(generatedRoot, ${JSON.stringify(owner)});`,
    )
    .join("\n");
  const provisioningEntrypoints = provisioningOwners
    .map(
      (owner) =>
        `export const ${provisioningEntrypointName(owner)} = resolve(\n  deploymentRoot,\n  ${JSON.stringify(`components/${owner}/provisioning.ts`)},\n);`,
    )
    .join("\n");
  return `import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const deploymentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packageRoot = resolve(deploymentRoot, ${JSON.stringify(packagePath.split(sep).join("/"))});
export const generatedRoot = resolve(deploymentRoot, ".generated");
export const environmentRoot = resolve(deploymentRoot, "environments");
${generatedProjects}
${provisioningEntrypoints}
${hasEntra ? `export const generatedIdentityProject = resolve(generatedRoot, "identity");
export const identityBootstrapEntrypoint = resolve(
  deploymentRoot,
  "components/shared/identity-bootstrap.ts",
);
export const identityConfigurationEntrypoint = resolve(
  deploymentRoot,
  "components/shared/identity-configuration.ts",
);` : ""}
`;
}

export function renderRuntimeEnvironmentSource(solutionName: string): string {
  return `import { resolve } from "node:path";

import {
  createAzdProject,
  readEnvironmentFile,
  requiredEnv,
  resolveAzureSubscriptionContext,
  stringEnvironment,
  type Deployment,
  type EnvironmentValues,
} from "imperative-deploy";
import { environmentRoot, generatedRoot } from "./paths.js";

export { requiredEnv, type EnvironmentValues };

export async function prepareEnvironment(deployment: Deployment): Promise<void> {
  const name = deployment.environment ?? process.env.AZURE_ENV_NAME ?? "dev";
  const shellValues = stringEnvironment(process.env);
  const configuredValues = await readEnvironmentFile(
    resolve(environmentRoot, \`\${name}.json\`),
  );
  const persistedValues = deployment.dryRun
    ? {}
    : await environmentProject(deployment, name).getValues();
  Object.assign(process.env, configuredValues, persistedValues, shellValues, {
    AZURE_ENV_NAME: name,
  });
  process.env.AZURE_LOCATION ??= "westus2";
  if (deployment.dryRun) {
    await environmentProject(deployment, name).initialize();
  }

  await deployment.deploy("resolve Azure account context", async () => {
    const account = await resolveAzureSubscriptionContext(deployment, {
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      tenantId: process.env.AZURE_TENANT_ID,
    });
    process.env.AZURE_SUBSCRIPTION_ID = account.subscriptionId;
    process.env.AZURE_TENANT_ID = account.tenantId;
    await persistEnvironment(deployment, {
      AZURE_SUBSCRIPTION_ID: account.subscriptionId,
      AZURE_TENANT_ID: account.tenantId,
      AZURE_LOCATION: requiredEnv("AZURE_LOCATION"),
    });
  });
  if (deployment.dryRun) {
    process.env.AZURE_SUBSCRIPTION_ID ??= "00000000-0000-0000-0000-000000000000";
    process.env.AZURE_TENANT_ID ??= "00000000-0000-0000-0000-000000000000";
  }
}

export async function persistEnvironment(
  deployment: Deployment,
  values: EnvironmentValues,
): Promise<void> {
  await environmentProject(deployment).setValues(values);
}

function environmentProject(deployment: Deployment, environment?: string) {
  return createAzdProject(deployment, {
    directory: generatedRoot,
    environment,
    mergeManifest: true,
    manifest: {
      name: ${JSON.stringify(generatedAzdProjectName(solutionName))},
      requiredVersions: { azd: ">= 1.30.0" },
    },
  });
}
`;
}

export function renderSharedComponentSource(
  roles: readonly {
    readonly provider: string;
    readonly role: string;
    readonly roleDefinitionId: string;
    readonly reason: string;
  }[],
  hasEntra: boolean,
): string {
  const renderedRoles = roles
    .map((role) => `        ${JSON.stringify(role)},`)
    .join("\n");
  const grantStep = roles.length === 0
    ? ""
    : `  await deployment.deploy("grant deployment data-plane roles", async () => {
    await ensureDeploymentPrincipalRoles(deployment, {
      subscriptionId: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      tenantId: process.env.AZURE_TENANT_ID,
      principalId: process.env.AZURE_PRINCIPAL_ID,
      principalType: process.env.AZURE_PRINCIPAL_TYPE,
      scope: \`/subscriptions/\${requiredEnv("AZURE_SUBSCRIPTION_ID")}/resourceGroups/\${resourceGroup}\`,
      roles: [
    ${renderedRoles}
      ],
    });
  });
`;
  return `import {
  ensureDeploymentPrincipalRoles,
  ensureResourceGroup,
  type Deployment,
} from "imperative-deploy";
import { persistEnvironment, requiredEnv } from "../../runtime/environment.js";
import {
  generatedSharedProject,
  sharedProvisioningEntrypoint,
} from "../../runtime/paths.js";
import { solutionName } from "./provisioning.js";
${hasEntra ? 'import { ensureEntraApplications } from "./identity.js";' : ""}

export async function shared(deployment: Deployment): Promise<void> {
  const environment = requiredEnv("AZURE_ENV_NAME");
  const resourceGroup =
    process.env.AZURE_RESOURCE_GROUP?.trim() ||
    \`rg-\${solutionName}-\${environment}\`;
  process.env.AZURE_RESOURCE_GROUP = resourceGroup;
  await deployment.deploy("ensure deployment resource group", async () => {
    await ensureResourceGroup(deployment, {
      name: resourceGroup,
      location: requiredEnv("AZURE_LOCATION"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
${grantStep}  const outputs = await deployment.provision("solution infrastructure", {
    entrypoint: sharedProvisioningEntrypoint,
    outputDirectory: generatedSharedProject,
    layer: "shared",
    deploymentName: \`\${environment}-\${solutionName}\`,
    scope: "resourceGroup",
    resourceGroup,
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
  });
  await deployment.deploy("persist solution infrastructure", async () => {
    await persistEnvironment(deployment, outputs);
  });
${hasEntra ? `  await ensureEntraApplications(deployment);
` : ""}}
`;
}

function escapeTemplateLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function generatedAzdProjectName(solutionName: string): string {
  const normalized = solutionName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return `imperative-deploy-${normalized || "app"}`;
}