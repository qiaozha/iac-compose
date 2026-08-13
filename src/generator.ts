import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  entraConfigurationOwner,
  hasEntraApplications,
  provisioningDependencies,
  renderEntraIdentityBootstrapSource,
  renderEntraIdentityConfigurationSource,
  renderEntraIdentityLifecycleSource,
  renderGraphProvisioningHelper,
  renderProvisioningSources,
  renderWorkflowDefinitionSources,
} from "./provisioning-source.js";
import { planResourceValidation } from "./resource-validation.js";

const generatedManifest = ".deploy-js-codegen.json";
const outputBindingPattern = /\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}/g;
const chatbotServiceManagementReference =
  "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4";

export interface GenerateDeploymentCodeOptions {
  resourcesFile: string;
  solutionFile: string;
  outputDirectory: string;
}

export interface GenerateDeploymentCodeResult {
  components: readonly string[];
  files: readonly string[];
}

export interface ResourceRequirement {
  id: string;
  kind: string;
  requiredBy: readonly string[];
  produces?: readonly string[];
  source?: string;
  [key: string]: unknown;
}

export interface ResourceRequirements {
  schemaVersion: string;
  solution: {
    name: string;
    enabledComponents: readonly string[];
  };
  resources: readonly ResourceRequirement[];
  outputBindings?: { syntax?: string };
}

export interface DeploymentSolution {
  schemaVersion: string;
  customer?: { name?: string; displayName?: string };
  components: readonly {
    id: string;
    name?: string;
    kind?: string;
    source?: string;
  }[];
  resources?: {
    contract?: string;
    planned?: readonly { id: string; kind: string }[];
  };
}

export async function generateDeploymentCode(
  options: GenerateDeploymentCodeOptions,
): Promise<GenerateDeploymentCodeResult> {
  const resourcesFile = resolve(options.resourcesFile);
  const solutionFile = resolve(options.solutionFile);
  const outputDirectory = resolve(options.outputDirectory);
  const [requirements, solutionValue] = await Promise.all([
    loadResourceRequirements(resourcesFile),
    readJson(solutionFile),
  ]);
  const solution = parseDeploymentSolution(solutionValue, solutionFile);
  validateContracts(requirements, solution);
  const validationPlan = planResourceValidation(requirements, solution);

  const orderedComponents = orderComponents(requirements, solution);
  const componentNames = new Map(
    orderedComponents.map((component) => [component, typescriptIdentifier(component)]),
  );
  ensureUniqueIdentifiers(componentNames);
  const solutionDirectory = dirname(solutionFile);
  const packagePath = relative(outputDirectory, solutionDirectory) || ".";
  const templates = await loadWorkflowTemplates(requirements, solutionDirectory);
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const localPackagePath = normalizeRelativePath(
    relative(outputDirectory, repositoryRoot) || ".",
  );
  const sourceOptions = {
    requirements,
    solution,
    orderedComponents,
    templates,
    serviceManagementReference: chatbotServiceManagementReference,
  } as const;
  const provisioningSources = renderProvisioningSources(sourceOptions);
  const hasEntra = hasEntraApplications(sourceOptions);
  const identityConfigurationOwner = entraConfigurationOwner(sourceOptions);
  const files = new Map<string, string>();

  files.set(
    "package.json",
    `${JSON.stringify(
      {
        name: `${requirements.solution.name}-deployment`,
        private: true,
        type: "module",
        scripts: { typecheck: "tsc -p tsconfig.json --noEmit" },
        dependencies: {
          "imperative-deploy": `file:${localPackagePath}`,
          ...(requirements.resources.length > 0
            ? provisioningDependencies(outputDirectory, repositoryRoot)
            : {}),
        },
        devDependencies: { "@types/node": "^24.0.0", typescript: "^6.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  files.set(
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          types: ["node"],
          skipLibCheck: true,
        },
        include: ["**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  files.set(
    "deploy.ts",
    renderDeployment(orderedComponents, componentNames, requirements.solution.name),
  );
  files.set(
    "runtime/paths.ts",
    renderPaths(packagePath, ["shared", ...orderedComponents], [
      ...provisioningSources.keys(),
    ], hasEntra),
  );
  files.set("runtime/environment.ts", renderEnvironment());
  for (const [owner, source] of provisioningSources) {
    files.set(`components/${owner}/provisioning.ts`, source);
  }
  if (requirements.resources.length > 0) {
    files.set(
      "components/shared/graph-provisioning.ts",
      renderGraphProvisioningHelper(),
    );
  }
  if (hasEntra) {
    files.set(
      "components/shared/identity-bootstrap.ts",
      renderEntraIdentityBootstrapSource(sourceOptions),
    );
    files.set(
      "components/shared/identity-configuration.ts",
      renderEntraIdentityConfigurationSource(sourceOptions),
    );
    files.set(
      "components/shared/identity.ts",
      renderEntraIdentityLifecycleSource(sourceOptions),
    );
  }
  for (const [path, contents] of renderWorkflowDefinitionSources(sourceOptions)) {
    files.set(path, contents);
  }
  files.set(
    "components/shared/index.ts",
    renderSharedComponent(validationPlan.roles, hasEntra),
  );

  for (const component of orderedComponents) {
    const componentResources = requirements.resources.filter((resource) =>
      resource.requiredBy.includes(component),
    );
    const solutionComponent = solution.components.find(
      (candidate) => candidate.id === component,
    );
    files.set(
      `components/${component}/index.ts`,
      renderComponent(
        component,
        componentNames.get(component)!,
        solutionComponent?.kind,
        solutionComponent?.source,
        componentResources,
        requirements.resources,
        provisioningSources.has(component),
        component === identityConfigurationOwner,
      ),
    );
  }

  await installGeneratedFiles(outputDirectory, files);
  return {
    components: ["shared", ...orderedComponents],
    files: [...files.keys()].sort(),
  };
}

export async function loadResourceRequirements(
  path: string,
): Promise<ResourceRequirements> {
  const resolvedPath = resolve(path);
  return parseResourceRequirements(await readJson(resolvedPath), resolvedPath);
}

function parseResourceRequirements(
  value: unknown,
  path: string,
): ResourceRequirements {
  const object = requiredObject(value, path);
  const solution = requiredObject(object.solution, `${path}: solution`);
  const resources = requiredArray(object.resources, `${path}: resources`).map(
    (resource, index) => {
      const item = requiredObject(resource, `${path}: resources[${index}]`);
      return {
        ...item,
        id: requiredString(item.id, `${path}: resources[${index}].id`),
        kind: requiredString(item.kind, `${path}: resources[${index}].kind`),
        requiredBy: stringArray(
          item.requiredBy,
          `${path}: resources[${index}].requiredBy`,
        ),
        ...(item.produces === undefined
          ? {}
          : {
              produces: stringArray(
                item.produces,
                `${path}: resources[${index}].produces`,
              ),
            }),
        ...(item.source === undefined
          ? {}
          : { source: requiredString(item.source, `${path}: resources[${index}].source`) }),
      } satisfies ResourceRequirement;
    },
  );
  return {
    ...object,
    schemaVersion: requiredString(object.schemaVersion, `${path}: schemaVersion`),
    solution: {
      ...solution,
      name: requiredString(solution.name, `${path}: solution.name`),
      enabledComponents: stringArray(
        solution.enabledComponents,
        `${path}: solution.enabledComponents`,
      ),
    },
    resources,
  } as ResourceRequirements;
}

function parseDeploymentSolution(value: unknown, path: string): DeploymentSolution {
  const object = requiredObject(value, path);
  const components = requiredArray(object.components, `${path}: components`).map(
    (component, index) => {
      const item = requiredObject(component, `${path}: components[${index}]`);
      return {
        id: requiredString(item.id, `${path}: components[${index}].id`),
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.kind === "string" ? { kind: item.kind } : {}),
        ...(typeof item.source === "string" ? { source: item.source } : {}),
      };
    },
  );
  return {
    ...object,
    schemaVersion: requiredString(object.schemaVersion, `${path}: schemaVersion`),
    components,
  } as DeploymentSolution;
}

function validateContracts(
  requirements: ResourceRequirements,
  solution: DeploymentSolution,
): void {
  if (requirements.schemaVersion !== "1.0" || solution.schemaVersion !== "1.0") {
    throw new Error("Deployment generation supports schemaVersion '1.0'.");
  }
  const enabled = new Set(requirements.solution.enabledComponents);
  if (enabled.size !== requirements.solution.enabledComponents.length) {
    throw new Error("resource requirements contain duplicate enabled components.");
  }
  const solutionIds = solution.components.map((component) => component.id);
  if (new Set(solutionIds).size !== solutionIds.length) {
    throw new Error("solution contains duplicate component ids.");
  }
  for (const component of enabled) {
    if (!solutionIds.includes(component)) {
      throw new Error(`Enabled component '${component}' is missing from solution.json.`);
    }
  }
  for (const component of solutionIds) {
    if (!enabled.has(component)) {
      throw new Error(
        `Solution component '${component}' is not enabled by the resource requirements.`,
      );
    }
  }

  const resourceIds = new Set<string>();
  const outputs = new Map<string, string>();
  for (const resource of requirements.resources) {
    if (resourceIds.has(resource.id)) {
      throw new Error(`Duplicate resource id '${resource.id}'.`);
    }
    resourceIds.add(resource.id);
    if (resource.requiredBy.length === 0) {
      throw new Error(`Resource '${resource.id}' must name at least one requiredBy component.`);
    }
    for (const component of resource.requiredBy) {
      if (!enabled.has(component)) {
        throw new Error(
          `Resource '${resource.id}' is required by unknown component '${component}'.`,
        );
      }
    }
    for (const output of resource.produces ?? []) {
      const existing = outputs.get(output);
      if (existing) {
        throw new Error(
          `Output '${output}' is produced by both '${existing}' and '${resource.id}'.`,
        );
      }
      outputs.set(output, resource.id);
    }
  }
  for (const binding of collectOutputBindings(requirements.resources)) {
    if (!outputs.has(binding)) {
      throw new Error(`Output binding '${binding}' has no producing resource.`);
    }
  }

  const planned = solution.resources?.planned;
  if (planned) {
    const plannedById = new Map(planned.map((resource) => [resource.id, resource.kind]));
    for (const resource of requirements.resources) {
      const plannedKind = plannedById.get(resource.id);
      if (!plannedKind) {
        throw new Error(`Resource '${resource.id}' is missing from solution.resources.planned.`);
      }
      if (plannedKind !== resource.kind) {
        throw new Error(
          `Resource '${resource.id}' is '${resource.kind}' in requirements but '${plannedKind}' in solution.`,
        );
      }
    }
    for (const resource of planned) {
      if (!resourceIds.has(resource.id)) {
        throw new Error(
          `Planned resource '${resource.id}' is missing from the resource requirements.`,
        );
      }
    }
  }
}

function orderComponents(
  requirements: ResourceRequirements,
  solution: DeploymentSolution,
): string[] {
  const components = solution.components.map((component) => component.id);
  const sourceOrder = new Map(
    components.map((component, index) => [component, index]),
  );
  const componentKinds = new Map(
    solution.components.map((component) => [component.id, component.kind]),
  );
  const producers = new Map<string, ResourceRequirement>();
  for (const resource of requirements.resources) {
    for (const output of resource.produces ?? []) producers.set(output, resource);
  }
  const dependencies = new Map(
    components.map((component) => [component, new Set<string>()]),
  );
  for (const resource of requirements.resources) {
    const bindings = collectComponentBindings(resource);
    for (const binding of bindings) {
      const producer = producers.get(binding)!;
      if (producer.requiredBy.length !== 1) continue;
      const dependency = producer.requiredBy[0]!;
      for (const component of resource.requiredBy) {
        if (component !== dependency) dependencies.get(component)!.add(dependency);
      }
    }
  }

  const ordered: string[] = [];
  const remaining = new Set(components);
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((component) =>
        [...dependencies.get(component)!].every((dependency) =>
          ordered.includes(dependency),
        ),
      )
      .sort((left, right) => {
        const hostedDifference =
          Number(componentKinds.get(right) === "hosted-agent") -
          Number(componentKinds.get(left) === "hosted-agent");
        return hostedDifference || sourceOrder.get(left)! - sourceOrder.get(right)!;
      });
    if (ready.length === 0) {
      const cycle = [...remaining]
        .map(
          (component) =>
            `${component} -> ${[...dependencies.get(component)!]
              .filter((dependency) => remaining.has(dependency))
              .join(", ")}`,
        )
        .join("; ");
      throw new Error(`Component output bindings contain a dependency cycle: ${cycle}.`);
    }
    for (const component of ready) {
      remaining.delete(component);
      ordered.push(component);
    }
  }
  return ordered;
}

function collectComponentBindings(resource: ResourceRequirement): Set<string> {
  if (resource.kind === "container-host") {
    return collectOutputBindings(
      (resource.configuration as Record<string, unknown> | undefined)
        ?.runtimeSettings,
    );
  }
  if (resource.kind === "teams-application") {
    return collectOutputBindings(
      (resource.configuration as Record<string, unknown> | undefined)
        ?.manifestValues,
    );
  }
  if (resource.kind === "workflow-host") {
    return collectOutputBindings(resource.parameters);
  }
  return new Set();
}

function collectOutputBindings(value: unknown): Set<string> {
  const bindings = new Set<string>();
  const source = JSON.stringify(value);
  if (source === undefined) return bindings;
  for (const match of source.matchAll(outputBindingPattern)) {
    if (match[1]) bindings.add(match[1]);
  }
  return bindings;
}

function renderDeployment(
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

function renderPaths(
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
export const stateRoot = resolve(deploymentRoot, ".state");
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

function renderEnvironment(): string {
  return `import { resolve } from "node:path";

import {
  persistEnvironmentFile,
  readEnvironmentFile,
  requiredEnv,
  resolveAzureSubscriptionContext,
  stringEnvironment,
  type Deployment,
  type EnvironmentValues,
} from "imperative-deploy";
import { environmentRoot, stateRoot } from "./paths.js";

export { requiredEnv, type EnvironmentValues };

export async function prepareEnvironment(deployment: Deployment): Promise<void> {
  const name = deployment.environment ?? process.env.AZURE_ENV_NAME ?? "dev";
  const shellValues = stringEnvironment(process.env);
  const configuredValues = await readEnvironmentFile(
    resolve(environmentRoot, \`\${name}.json\`),
  );
  const persistedValues = await readEnvironmentFile(stateFile(name));
  Object.assign(process.env, configuredValues, persistedValues, shellValues, {
    AZURE_ENV_NAME: name,
  });
  process.env.AZURE_LOCATION ??= "westus2";

  await deployment.deploy("resolve Azure account context", async () => {
    const account = await resolveAzureSubscriptionContext(deployment, {
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      tenantId: process.env.AZURE_TENANT_ID,
    });
    process.env.AZURE_SUBSCRIPTION_ID = account.subscriptionId;
    process.env.AZURE_TENANT_ID = account.tenantId;
    await persistEnvironment(name, {
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
  name: string,
  values: EnvironmentValues,
): Promise<void> {
  await persistEnvironmentFile(stateFile(name), values);
  Object.assign(process.env, values);
}

function stateFile(name: string): string {
  return resolve(stateRoot, \`\${name}.json\`);
}
`;
}

function renderSharedComponent(
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
    deploymentName: \`\${environment}-\${solutionName}\`,
    scope: "resourceGroup",
    resourceGroup,
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
  });
  await deployment.deploy("persist solution infrastructure", async () => {
    await persistEnvironment(environment, outputs);
  });
${hasEntra ? `  await ensureEntraApplications(deployment);
` : ""}}
`;
}

function renderComponent(
  component: string,
  functionName: string,
  kind: string | undefined,
  source: string | undefined,
  resources: readonly ResourceRequirement[],
  allResources: readonly ResourceRequirement[],
  hasProvisioning: boolean,
  configureEntra: boolean,
): string {
  if (kind === "hosted-agent") {
    return renderHostedAgentComponent(
      component,
      functionName,
      source,
      resources,
      hasProvisioning,
    );
  }
  if (kind === "workflow") {
    return renderWorkflowComponent(
      component,
      functionName,
      resources,
      allResources,
      hasProvisioning,
      configureEntra,
    );
  }
  return renderContainerComponent(
    component,
    functionName,
    source,
    resources,
    allResources,
    hasProvisioning,
    configureEntra,
  );
}

function renderContainerComponent(
  component: string,
  functionName: string,
  source: string | undefined,
  resources: readonly ResourceRequirement[],
  allResources: readonly ResourceRequirement[],
  hasProvisioning: boolean,
  configureEntra: boolean,
): string {
  const containers = resources.filter(
    (candidate) =>
      candidate.kind === "container-host" &&
      candidate.requiredBy.includes(component),
  );
  if (containers.length !== 1) {
    throw new Error(
      `Component '${component}' requires exactly one container-host resource; found ${containers.length}.`,
    );
  }
  const resource = containers[0]!;
  const configuration = asRecord(resource.configuration);
  const runtimeSettings = asRecord(configuration.runtimeSettings);
  const ingress = asRecord(configuration.ingress);
  const ingressMode = ingress.mode === undefined
    ? Object.keys(ingress).length > 0 ? "restricted" : undefined
    : requiredString(
        ingress.mode,
        `${resource.id}.configuration.ingress.mode`,
      );
  if (
    ingressMode !== undefined &&
    ingressMode !== "restricted" &&
    ingressMode !== "unrestricted"
  ) {
    throw new Error(
      `${resource.id}.configuration.ingress.mode must be 'restricted' or 'unrestricted'.`,
    );
  }
  const ingressDefaultAction = ingressMode === "restricted"
    ? "Deny"
    : ingressMode === "unrestricted" ? "Allow" : undefined;
  const allowedServiceTags =
    ingress.allowedServiceTags === undefined
      ? []
      : stringArray(
          ingress.allowedServiceTags,
          `${resource.id}.configuration.ingress.allowedServiceTags`,
        );
  const peerIngressTargets = allResources.filter((candidate) => {
    if (candidate.kind !== "container-host" || candidate.id === resource.id) {
      return false;
    }
    const candidateIngress = asRecord(
      asRecord(candidate.configuration).ingress,
    );
    const allowedSourceResources =
      candidateIngress.allowedSourceResources === undefined
        ? []
        : stringArray(
            candidateIngress.allowedSourceResources,
            `${candidate.id}.configuration.ingress.allowedSourceResources`,
          );
    return allowedSourceResources.includes(resource.id);
  });
  const environmentEntries = Object.entries(runtimeSettings)
    .map(
      ([name, value]) =>
        `      ${JSON.stringify(name)}: ${renderRuntimeValue(value)},`,
    )
    .join("\n");
  const teamsApplications = resources.filter(
    (candidate) => candidate.kind === "teams-application",
  );
  if (teamsApplications.length > 1) {
    throw new Error(
      `Component '${component}' supports at most one teams-application resource; found ${teamsApplications.length}.`,
    );
  }
  const teamsBlock = teamsApplications[0]
    ? renderTeamsApplicationBlock(component, teamsApplications[0], source)
    : "";
  const teamsImport = teamsApplications.length === 1
    ? "\n  provisionTeamsApplication,"
    : "";
  const ingressImports = [
    ...(ingressDefaultAction ? ["  ensureAppServiceIngress,"] : []),
    ...(peerIngressTargets.length > 0
      ? ["  ensureAppServicePeerIngress,"]
      : []),
  ];
  const ingressImport =
    ingressImports.length > 0 ? `\n${ingressImports.join("\n")}` : "";
  const entraConfigurationImport = configureEntra
    ? 'import { configureEntraApplications } from "../shared/identity.js";\n'
    : "";
  const entraConfigurationBlock = configureEntra
    ? "  await configureEntraApplications(deployment);\n"
    : "";
  const serviceTagIngressBlock =
    ingressDefaultAction
      ? `  await deployment.deploy(${JSON.stringify(`configure ${component} ingress`)}, async () => {
    await ensureAppServiceIngress(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      siteName: requiredEnv(${JSON.stringify(implementationOutputName(resource.id, "NAME"))}),
      serviceTags: ${JSON.stringify(allowedServiceTags)},
      defaultAction: ${JSON.stringify(ingressDefaultAction)},
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
`
      : "";
  const peerIngressBlock = peerIngressTargets
    .map(
      (target) => `  await deployment.deploy(${JSON.stringify(`configure ${resource.id} access to ${target.id}`)}, async () => {
    await ensureAppServicePeerIngress(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      sourceSiteName: requiredEnv(${JSON.stringify(implementationOutputName(resource.id, "NAME"))}),
      targetSiteName: requiredEnv(${JSON.stringify(implementationOutputName(target.id, "NAME"))}),
      sourceResourceName: ${JSON.stringify(resource.id)},
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
`,
    )
    .join("");
  const generatedProject = generatedProjectName(component);
  const pathImports = componentPathImports(component, hasProvisioning, true);
  const provisioning = componentProvisioningBlock(
    component,
    hasProvisioning,
    false,
    resources,
  );
  return `import { resolve } from "node:path";

import {
  deployAppServiceContainer,${ingressImport}
  prepareAppServiceContainer,${teamsImport}
  type Deployment,
  waitForAppServiceReady,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
${entraConfigurationImport}import {
${pathImports}
} from "../../runtime/paths.js";

export async function ${functionName}(deployment: Deployment): Promise<void> {
  const outputs: Record<string, string> = {};
${provisioning}
${entraConfigurationBlock}${serviceTagIngressBlock}${peerIngressBlock}  const service = {
    directory: ${generatedProject},
    service: ${JSON.stringify(component)},
    ...(deployment.dryRun
      ? {}
      : { resourceName: requiredEnv(${JSON.stringify(implementationOutputName(resource.id, "NAME"))}) }),
    project: resolve(packageRoot, ${JSON.stringify(resource.source ?? source ?? ".")}),
    dockerfile: "Dockerfile",
    context: ".",
    imageName: ${JSON.stringify(component)},
    remoteBuild: true,
    environment: {
${environmentEntries}
    },
  } as const;
  if (deployment.dryRun) await prepareAppServiceContainer(deployment, service);
  await deployment.deploy(${JSON.stringify(`${component} container '${resource.id}'`)}, async () => {
    Object.assign(outputs, await deployAppServiceContainer(deployment, service));
    await waitForAppServiceReady(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      siteName: requiredEnv(${JSON.stringify(implementationOutputName(resource.id, "NAME"))}),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
${teamsBlock}
  await deployment.deploy("persist ${escapeTemplateLiteral(component)} deployment outputs", async () => {
    await persistEnvironment(requiredEnv("AZURE_ENV_NAME"), outputs);
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "\${" + name + "}" : requiredEnv(name);
}
`;
}

function renderHostedAgentComponent(
  component: string,
  functionName: string,
  source: string | undefined,
  resources: readonly ResourceRequirement[],
  hasProvisioning: boolean,
): string {
  const ownsModelDeployment = resources.some(
    (resource) => resource.kind === "model-deployment",
  );
  const containers = resources.filter(
    (resource) =>
      resource.kind === "container-host" &&
      resource.requiredBy.includes(component),
  );
  if (containers.length !== 1) {
    throw new Error(
      `Hosted agent '${component}' requires exactly one container-host resource; found ${containers.length}.`,
    );
  }
  const container = containers[0]!;
  const runtimeSettings = asRecord(
    asRecord(container.configuration).runtimeSettings,
  );
  const environment = Object.entries(runtimeSettings)
    .map(
      ([name, value]) =>
        `      ${JSON.stringify(name)}: ${renderRuntimeValue(value)},`,
    )
    .join("\n");
  const principalOutputs = new Set(container.produces ?? []);
  const access = resources.flatMap((resource) =>
    accessRecords(resource)
      .filter((grant) => principalOutputs.has(grant.principalOutput))
      .map(
        (grant) => `      {
          role: ${JSON.stringify(grant.role)},
          scope: deploymentValue(
            deployment,
            ${JSON.stringify(implementationOutputName(resource.id, "ACCESS_SCOPE"))},
          ),
        },`,
      ),
  );
  const configuration = resources.find(
    (resource) => resource.kind === "configuration-store",
  );
  const endpointOutput =
    container.produces?.find((output) => /Endpoint$/i.test(output)) ??
    "agentEndpoint";
  const principalOutput =
    container.produces?.find((output) => /IdentityPrincipalId$/i.test(output)) ??
    "agentIdentityPrincipalId";
  const generatedProject = generatedProjectName(component);
  const pathImports = componentPathImports(component, hasProvisioning, true);
  const provisioning = componentProvisioningBlock(
    component,
    hasProvisioning,
    false,
    resources,
  );
  return `import { resolve } from "node:path";

import {
  deployHostedAgentService,
  type Deployment,
} from "imperative-deploy";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
import {
${pathImports}
} from "../../runtime/paths.js";

export async function ${functionName}(deployment: Deployment): Promise<void> {
${provisioning}
  const outputs = await deployHostedAgentService(deployment, {
    component: ${JSON.stringify(component)},
    generatedDirectory: ${generatedProject},
    sourceDirectory: resolve(packageRoot, ${JSON.stringify(container.source ?? source ?? ".")}),
    name: deploymentValue(deployment, "agentName"),
    environment: {
${environment}
    },
    endpointOutput: ${JSON.stringify(endpointOutput)},
    principalIdOutput: ${JSON.stringify(principalOutput)},
    access: deployment.dryRun
      ? []
      : [
${access.join("\n")}
      ],
${configuration ? `    configurationStoreName: deployment.dryRun\n      ? undefined\n      : requiredEnv(${JSON.stringify(implementationOutputName(configuration.id, "NAME"))}),\n` : ""}
  });
${ownsModelDeployment ? `  const persistedDeploymentOutputs = { ...outputs };
  delete persistedDeploymentOutputs.AZURE_LOCATION;
  process.env.AZURE_LOCATION = solutionLocation;
` : ""}  await deployment.deploy("persist ${escapeTemplateLiteral(component)} deployment outputs", async () => {
    await persistEnvironment(
      requiredEnv("AZURE_ENV_NAME"),
      ${ownsModelDeployment ? "persistedDeploymentOutputs" : "outputs"},
    );
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "\${" + name + "}" : requiredEnv(name);
}
`;
}

function renderTeamsApplicationBlock(
  component: string,
  resource: ResourceRequirement,
  source: string | undefined,
): string {
  const values = asRecord(asRecord(resource.configuration).manifestValues);
  const existingAppId = asRecord(resource.configuration).existingAppId;
  if (
    existingAppId !== undefined &&
    (typeof existingAppId !== "string" || !existingAppId.trim())
  ) {
    throw new Error(
      `${resource.id}.configuration.existingAppId must be a non-empty string.`,
    );
  }
  const entries = Object.entries(values)
    .filter(([name]) => name !== "TEAMS_APP_ID")
    .map(
      ([name, value]) =>
        `        ${JSON.stringify(name)}: ${renderRuntimeValue(value)},`,
    )
    .join("\n");
  return `  Object.assign(
    outputs,
    await provisionTeamsApplication(deployment, {
      component: ${JSON.stringify(component)},
      componentDirectory: resolve(packageRoot, ${JSON.stringify(source ?? ".")}),
${existingAppId ? `      existingAppId: ${JSON.stringify(existingAppId)},\n` : ""}      manifestValues: {
${entries}
      },
      outputNames: ${JSON.stringify(resource.produces ?? [])},
    }),
  );`;
}

function renderWorkflowComponent(
  component: string,
  functionName: string,
  resources: readonly ResourceRequirement[],
  allResources: readonly ResourceRequirement[],
  hasProvisioning: boolean,
  configureEntra: boolean,
): string {
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
} from "imperative-deploy";
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

function componentProvisioningBlock(
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
      deploymentName: \`\${requiredEnv("AZURE_ENV_NAME")}-${escapeTemplateLiteral(component)}\`,
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: ${location},
${locationOverride}    },
  );
${filterAiLocation}  await deployment.deploy(${JSON.stringify(`persist ${component} infrastructure`)}, async () => {
    await persistEnvironment(
      requiredEnv("AZURE_ENV_NAME"),
      ${persistedOutputs},
    );
  });
${mergeOutputs ? `  Object.assign(outputs, ${persistedOutputs});\n` : ""}`;
}

function componentPathImports(
  component: string,
  hasProvisioning: boolean,
  includePackageRoot: boolean,
): string {
  return [
    `  ${generatedProjectName(component)},`,
    ...(hasProvisioning ? [`  ${provisioningEntrypointName(component)},`] : []),
    ...(includePackageRoot ? ["  packageRoot,"] : []),
  ].join("\n");
}

function generatedProjectName(component: string): string {
  return `generated${pascalIdentifier(component)}Project`;
}

function provisioningEntrypointName(component: string): string {
  return `${typescriptIdentifier(component)}ProvisioningEntrypoint`;
}

function pascalIdentifier(value: string): string {
  const name = typescriptIdentifier(value);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function renderRuntimeValue(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value);
  const exact = /^\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value);
  if (exact) return `deploymentValue(deployment, ${JSON.stringify(exact[1])})`;
  const parts: string[] = [];
  let offset = 0;
  for (const match of value.matchAll(outputBindingPattern)) {
    if (match.index! > offset) parts.push(JSON.stringify(value.slice(offset, match.index)));
    parts.push(`deploymentValue(deployment, ${JSON.stringify(match[1])})`);
    offset = match.index! + match[0].length;
  }
  if (parts.length === 0) return JSON.stringify(value);
  if (offset < value.length) parts.push(JSON.stringify(value.slice(offset)));
  return parts.join(" + ");
}

function implementationOutputName(resourceId: string, suffix: string): string {
  return `DEPLOY_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${suffix}`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function accessRecords(resource: ResourceRequirement): Array<{
  principalOutput: string;
  role: string;
}> {
  return Array.isArray(resource.access)
    ? resource.access.map((value, index) => {
        const record = asRecord(value);
        return {
          principalOutput: requiredGeneratedString(
            record.principalOutput,
            `${resource.id}.access[${index}].principalOutput`,
          ),
          role: requiredGeneratedString(
            record.role,
            `${resource.id}.access[${index}].role`,
          ),
        };
      })
    : [];
}

function hasOutputBinding(value: unknown): boolean {
  return /\$\{output\.[A-Za-z][A-Za-z0-9_]*\}/.test(JSON.stringify(value));
}

function exactOutputBinding(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^\$\{output\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
}

function workflowEnvironmentName(resourceId: string, parameter: string): string {
  return `DEPLOY_WORKFLOW_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${parameter.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function workflowDeploymentEnvironmentName(resourceId: string): string {
  return `DEPLOY_WORKFLOW_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function requiredGeneratedString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

async function loadWorkflowTemplates(
  requirements: ResourceRequirements,
  solutionDirectory: string,
): Promise<Readonly<Record<string, unknown>>> {
  const templates: Record<string, unknown> = {};
  for (const resource of requirements.resources) {
    if (resource.kind !== "workflow-host") continue;
    if (!resource.source) {
      throw new Error(`Workflow resource '${resource.id}' requires a source template.`);
    }
    const templatePath = resolvePackagePath(solutionDirectory, resource.source);
    templates[resource.id] = await readJson(templatePath);
  }
  return templates;
}

function resolvePackagePath(packageDirectory: string, path: string): string {
  const resolvedPath = resolve(packageDirectory, path);
  const relativePath = relative(packageDirectory, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Resource source escapes the solution package: ${path}`);
  }
  return resolvedPath;
}

async function installGeneratedFiles(
  outputDirectory: string,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const manifestPath = resolve(outputDirectory, generatedManifest);
  for (const path of await readGeneratedManifest(manifestPath)) {
    await rm(resolveGeneratedPath(outputDirectory, path), { force: true });
  }
  for (const [path, contents] of files) {
    const outputPath = resolveGeneratedPath(outputDirectory, path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents);
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 1, files: [...files.keys()].sort() }, null, 2)}\n`,
  );
}

async function readGeneratedManifest(path: string): Promise<readonly string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("files" in value) ||
      !Array.isArray(value.files) ||
      !value.files.every((item) => typeof item === "string")
    ) {
      throw new Error(`Invalid generated deployment manifest '${path}'.`);
    }
    return value.files;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function resolveGeneratedPath(outputDirectory: string, path: string): string {
  const outputPath = resolve(outputDirectory, path);
  const relativePath = relative(outputDirectory, outputPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Generated deployment path escapes its directory: ${path}`);
  }
  return outputPath;
}

function typescriptIdentifier(value: string): string {
  const parts = value.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const identifier = parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  const candidate = /^[A-Za-z_$]/.test(identifier) ? identifier : `component${identifier}`;
  if (!candidate || reservedWords.has(candidate)) return `${candidate || "component"}Deployment`;
  return candidate;
}

function ensureUniqueIdentifiers(names: ReadonlyMap<string, string>): void {
  const componentsByName = new Map<string, string>();
  for (const [component, name] of names) {
    const existing = componentsByName.get(name);
    if (existing) {
      throw new Error(
        `Components '${existing}' and '${component}' both map to TypeScript identifier '${name}'.`,
      );
    }
    componentsByName.set(name, component);
  }
}

function requiredObject(value: unknown, name: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, any>;
}

function requiredArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  return requiredArray(value, name).map((item, index) =>
    requiredString(item, `${name}[${index}]`),
  );
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in '${path}': ${error.message}`);
    }
    throw error;
  }
}

function escapeTemplateLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function normalizeRelativePath(value: string): string {
  const normalized = value.split(sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const reservedWords = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);