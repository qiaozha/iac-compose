import { readFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { renderComponentSource } from "./generation/rendering/components/index.js";
import {
  loadDeploymentSolution,
  loadResourceRequirements,
  type ResourceRequirements,
} from "./generation/contracts/deployment.js";
import {
  orderDeploymentComponents,
  validateDeploymentContracts,
} from "./generation/planning/deployment.js";
import {
  renderDeploymentSource,
  renderRuntimeEnvironmentSource,
  renderRuntimePathsSource,
  renderSharedComponentSource,
} from "./generation/rendering/project.js";
import {
  ensureUniqueIdentifiers,
  typescriptIdentifier,
} from "./generation/rendering/names.js";
import { installGeneratedFiles } from "./generation/output/generated-files.js";
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
} from "./generation/provisioning/index.js";
import { planResourceValidation } from "./validation/resources/plan.js";

const chatbotServiceManagementReference =
  "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4";

export {
  loadResourceRequirements,
  type DeploymentSolution,
  type ResourceRequirement,
  type ResourceRequirements,
} from "./generation/contracts/deployment.js";

export interface GenerateDeploymentCodeOptions {
  resourcesFile: string;
  solutionFile: string;
  outputDirectory: string;
  onProgress?: (
    progress: DeploymentCodeGenerationProgress,
  ) => void | Promise<void>;
}

export interface DeploymentCodeGenerationProgress {
  stage:
    | "loadingInputs"
    | "validatingContracts"
    | "planningComponents"
    | "renderingSources"
    | "writingFiles"
    | "completed";
  percent: number;
  message: string;
  outputDirectory: string;
  componentCount?: number | undefined;
  fileCount?: number | undefined;
}

export interface GenerateDeploymentCodeResult {
  components: readonly string[];
  files: readonly string[];
}

export async function generateDeploymentCode(
  options: GenerateDeploymentCodeOptions,
): Promise<GenerateDeploymentCodeResult> {
  const resourcesFile = resolve(options.resourcesFile);
  const solutionFile = resolve(options.solutionFile);
  const outputDirectory = resolve(options.outputDirectory);
  await reportGenerationProgress(options, {
    stage: "loadingInputs",
    percent: 5,
    message: "Loading deployment contracts.",
    outputDirectory,
  });
  const [requirements, solution] = await Promise.all([
    loadResourceRequirements(resourcesFile),
    loadDeploymentSolution(solutionFile),
  ]);
  validateDeploymentContracts(requirements, solution);
  const validationPlan = planResourceValidation(requirements, solution);
  await reportGenerationProgress(options, {
    stage: "validatingContracts",
    percent: 20,
    message: "Validated deployment contracts.",
    outputDirectory,
  });

  const orderedComponents = orderDeploymentComponents(requirements, solution);
  await reportGenerationProgress(options, {
    stage: "planningComponents",
    percent: 35,
    message: `Planned ${orderedComponents.length} deployment components.`,
    outputDirectory,
    componentCount: orderedComponents.length,
  });
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
  await reportGenerationProgress(options, {
    stage: "renderingSources",
    percent: 50,
    message: "Rendering deployment source files.",
    outputDirectory,
    componentCount: orderedComponents.length,
  });

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
    renderDeploymentSource(
      orderedComponents,
      componentNames,
      requirements.solution.name,
    ),
  );
  files.set(
    "runtime/paths.ts",
    renderRuntimePathsSource(packagePath, [
      ...provisioningSources.keys(),
    ], hasEntra),
  );
  files.set(
    "runtime/environment.ts",
    renderRuntimeEnvironmentSource(requirements.solution.name),
  );
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
    renderSharedComponentSource(validationPlan.roles, hasEntra),
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
      renderComponentSource({
        component,
        functionName: componentNames.get(component)!,
        kind: solutionComponent?.kind,
        source: solutionComponent?.source,
        resources: componentResources,
        allResources: requirements.resources,
        hasProvisioning: provisioningSources.has(component),
        configureEntra: component === identityConfigurationOwner,
      }),
    );
  }

  await reportGenerationProgress(options, {
    stage: "writingFiles",
    percent: 90,
    message: `Writing ${files.size} generated deployment files.`,
    outputDirectory,
    componentCount: orderedComponents.length,
    fileCount: files.size,
  });
  await installGeneratedFiles(outputDirectory, files);
  await reportGenerationProgress(options, {
    stage: "completed",
    percent: 100,
    message: `Generated ${files.size} deployment files.`,
    outputDirectory,
    componentCount: orderedComponents.length,
    fileCount: files.size,
  });
  return {
    components: ["shared", ...orderedComponents],
    files: [...files.keys()].sort(),
  };
}

async function reportGenerationProgress(
  options: GenerateDeploymentCodeOptions,
  progress: DeploymentCodeGenerationProgress,
): Promise<void> {
  await options.onProgress?.(progress);
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

function normalizeRelativePath(value: string): string {
  const normalized = value.split(sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}