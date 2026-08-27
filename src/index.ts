import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { getAzdProject } from "./azd.js";
import { importTypeScript } from "./typescript-loader.js";

export {
  AzdProject,
  createAzdProject,
  getAzdProject,
  parseAzdEnvironment,
  type AzdDeployOptions,
  type AzdEnvironmentValues,
  type AzdProjectOptions,
} from "./azd.js";
export {
  authorizationError,
  buildContainerImage,
  captureAzure,
  captureAzureJson,
  createAppServiceContainerManifest,
  deployAppServiceContainer,
  ensureAppServiceClientAuthorization,
  ensureAppServiceContainerPullIdentity,
  ensureAppServiceIngress,
  ensureAppServicePrivateEndpoint,
  ensureAppServicePeerIngress,
  prepareAppServiceContainer,
  ensureResourceGroup,
  ensureRoleAssignment,
  resolveAzureAccountContext,
  resolveAzureSubscriptionContext,
  retry,
  runAzure,
  waitForAppServiceReady,
  waitForHttp,
  type AppServiceClientAuthorizationOptions,
  type AppServiceContainerOptions,
  type AppServiceIngressOptions,
  type AppServicePrivateEndpointOptions,
  type AppServicePeerIngressOptions,
  type AppServiceReadyOptions,
  type AzureAccountContext,
  type AzureAccountContextOptions,
  type AzureRoleAssignmentOptions,
  type AzureResourceGroupOptions,
  type AzureSubscriptionContext,
  type AzureSubscriptionContextOptions,
  type ContainerImageOptions,
} from "./azure.js";
export {
  optionalEnv,
  persistEnvironmentFile,
  readEnvironmentFile,
  requiredEnv,
  stringEnvironment,
  type EnvironmentValues,
} from "./environment.js";
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
export {
  createHostedAgentManifest,
  deployHostedAgentService,
  deployResourceComponent,
  enableWorkflowDeployment,
  parseHostedAgentVersion,
  prepareAuthorizedConnection,
  prepareResourceRequirements,
  provisionTeamsApplication,
  resolveOutputBindings,
  teamsEnvironmentName,
  type DeployResourceComponentOptions,
  type AuthorizedConnectionOptions,
  type HostedAgentAccess,
  type HostedAgentDeploymentOptions,
  type TeamsApplicationDeploymentOptions,
  type WorkflowDeploymentOptions,
} from "./runtime/resources/index.js";

export interface Command {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProvisioningLayer {
  readonly entrypoint: string;
  readonly outputDirectory: string;
}

export interface ProvisionOptions {
  layer?: ProvisioningLayer;
  entrypoint?: string;
  compiler?: Command;
  artifactsDirectory?: string;
  outputDirectory?: string;
  templateFile?: string;
  parametersFile?: string;
  deploymentName?: string;
  subscription?: string;
  location?: string;
  parameters?: Readonly<Record<string, string | number | boolean>>;
  scope?: "subscription" | "resourceGroup";
  resourceGroup?: string;
  environmentValues?: Readonly<Record<string, string | undefined>>;
}

export interface DeploymentOptions {
  projectDirectory?: string;
  environment?: string;
  component?: string;
  dryRun?: boolean;
  log?: (message: string) => void;
}

export type DeploymentProgram = (deployment: Deployment) => Promise<void>;
export type DeploymentAction = Command | (() => void | Promise<void>);
export type ProvisionOutputs = Record<string, string>;

interface RenderedFile {
  path: string;
  contents: string;
}

export function defineDeployment(program: DeploymentProgram): DeploymentProgram {
  return program;
}

export function createDeployment(options: DeploymentOptions = {}): Deployment {
  return new Deployment(options);
}

export class Deployment {
  readonly projectDirectory: string;
  readonly environment?: string;
  readonly component?: string;
  readonly dryRun: boolean;

  readonly #log: (message: string) => void;
  readonly #layersByProject = new Map<string, string[]>();

  constructor(options: DeploymentOptions = {}) {
    this.projectDirectory = resolve(options.projectDirectory ?? process.cwd());
    this.environment = options.environment;
    this.component = options.component;
    this.dryRun = options.dryRun ?? false;
    this.#log = options.log ?? console.log;
  }

  inDirectory(projectDirectory: string): Deployment {
    return new Deployment({
      projectDirectory,
      environment: this.environment,
      component: this.component,
      dryRun: this.dryRun,
      log: this.#log,
    });
  }

  async env(name: string, values: NodeJS.ProcessEnv): Promise<void> {
    await this.#step("env", name, async () => {
      Object.assign(process.env, values);
    });
  }

  async provision(name: string, options: ProvisionOptions): Promise<ProvisionOutputs> {
    let outputs: ProvisionOutputs = {};
    await this.#step("provision", name, async () => {
      if (
        options.layer &&
        (options.entrypoint ||
          options.outputDirectory ||
          options.compiler ||
          options.artifactsDirectory)
      ) {
        throw new Error(
          "Provisioning with a layer cannot also specify source or output options.",
        );
      }
      const outputDirectory = resolve(
        this.projectDirectory,
        options.layer?.outputDirectory ??
          options.outputDirectory ??
          ".deploy-js/infra",
      );
      const entrypoint = options.layer?.entrypoint ?? options.entrypoint;
      if (options.compiler && options.artifactsDirectory) {
        await this.#execute(options.compiler);
        await copyProvisioningArtifacts(
          resolve(this.projectDirectory, options.artifactsDirectory),
          outputDirectory,
        );
      } else if (entrypoint) {
        await compileProvisioning(
          resolve(this.projectDirectory, entrypoint),
          outputDirectory,
        );
      } else {
        throw new Error(
          "Provisioning requires either an entrypoint or a compiler with artifactsDirectory.",
        );
      }

      const parametersFile = resolve(
        outputDirectory,
        options.parametersFile ?? "main.bicepparam",
      );
      const templateFile = resolve(
        outputDirectory,
        options.templateFile ?? "main.bicep",
      );
      const environmentValues = {
        ...(await collectBicepEnvironmentValues(
          parametersFile,
          options.parameters,
        )),
        ...(options.resourceGroup
          ? { AZURE_RESOURCE_GROUP: options.resourceGroup }
          : {}),
        ...options.environmentValues,
      };
      const module = basename(templateFile, extname(templateFile));
      const layer = inferLayerName(outputDirectory);
      const azdProjectDirectory = layer ? dirname(outputDirectory) : outputDirectory;
      const dependsOn = layer
        ? this.#inferLayerDependencies(azdProjectDirectory, layer)
        : [];
      const infra = layer
        ? {
            provider: "bicep",
            layers: [
              {
                name: layer,
                path: relativeAzdPath(azdProjectDirectory, outputDirectory),
                module,
                ...(dependsOn.length ? { dependsOn } : {}),
              },
            ],
          }
        : {
            provider: "bicep",
            path: ".",
            module,
          };
      if (layer) {
            await rm(resolve(outputDirectory, "azure.yaml"), { force: true });
            await rm(resolve(outputDirectory, ".azure"), {
              recursive: true,
              force: true,
            });
        await writeFile(
          resolve(azdProjectDirectory, ".deploy-js-project.json"),
          `${JSON.stringify({ schemaVersion: "1.0", kind: "layered-azd-project" }, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
      const project = getAzdProject(this, {
        directory: azdProjectDirectory,
        mergeManifest: layer !== undefined,
        manifest: {
          name: sanitizeAzdName(
            options.deploymentName ?? basename(outputDirectory),
          ),
          ...(layer ? { requiredVersions: { azd: ">= 1.30.0" } } : {}),
          infra,
        },
        subscription:
          options.subscription ?? process.env.AZURE_SUBSCRIPTION_ID,
        location: options.location ?? process.env.AZURE_LOCATION,
        values: environmentValues,
      });
      outputs = await project.provision();
    }, true);
    return outputs;
  }

  async deploy(name: string, action: DeploymentAction): Promise<void> {
    await this.#step("deploy", name, async () => {
      if (typeof action === "function") await action();
      else await this.#execute(action);
    });
  }

  async run(name: string, command: Command): Promise<void> {
    await this.#step("command", name, async () => {
      await this.#execute(command);
    });
  }

  async execute(command: Command): Promise<void> {
    this.#log(`[deploy-js] $ ${formatCommand(command.command, command.args ?? [])}`);
    if (this.dryRun) return;
    await this.#execute(command, false, false);
  }

  async capture(command: Command): Promise<string> {
    this.#log(`[deploy-js] $ ${formatCommand(command.command, command.args ?? [])}`);
    if (this.dryRun) return "";
    return this.#execute(command, true, false);
  }

  #inferLayerDependencies(projectDirectory: string, layer: string): string[] {
    const layers = this.#layersByProject.get(projectDirectory) ?? [];
    if (!this.#layersByProject.has(projectDirectory)) {
      this.#layersByProject.set(projectDirectory, layers);
    }
    const existingIndex = layers.indexOf(layer);
    if (existingIndex >= 0) {
      return existingIndex === 0 ? [] : [layers[existingIndex - 1]!];
    }
    const dependsOn = layers.length > 0 ? [layers[layers.length - 1]!] : [];
    layers.push(layer);
    return dependsOn;
  }

  async #step(
    kind: string,
    name: string,
    action: () => Promise<void>,
    runInDryRun = false,
  ): Promise<void> {
    this.#log(`[deploy-js] ${this.dryRun ? "DRY" : "RUN"} ${kind}: ${name}`);
    if (this.dryRun && !runInDryRun) return;
    await action();
    if (!this.dryRun) this.#log(`[deploy-js] DONE ${kind}: ${name}`);
  }

  async #execute(command: Command, capture = false, log = true): Promise<string> {
    const args = [...(command.args ?? [])];
    if (log) this.#log(`[deploy-js] $ ${formatCommand(command.command, args)}`);

    return new Promise((resolvePromise, reject) => {
      const child = spawn(command.command, args, {
        cwd: resolve(this.projectDirectory, command.cwd ?? "."),
        env: { ...process.env, ...command.env },
        shell: false,
        stdio: capture ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        process.stderr.write(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) {
          resolvePromise(stdout);
          return;
        }
        reject(
          new Error(
            `${command.command} exited with ${signal ? `signal ${signal}` : `code ${code}`}` +
              (stderr.trim() ? `: ${stderr.trim()}` : ""),
          ),
        );
      });
    });
  }
}

function inferLayerName(outputDirectory: string): string | undefined {
  return basename(dirname(outputDirectory)) === ".generated"
    ? basename(outputDirectory)
    : undefined;
}

function relativeAzdPath(projectDirectory: string, outputDirectory: string): string {
  const path = relative(projectDirectory, outputDirectory);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(
      `Provisioning output directory '${outputDirectory}' must be inside azd project '${projectDirectory}'.`,
    );
  }
  return path ? `./${path.split(sep).join("/")}` : ".";
}

export async function compileProvisioning(
  entrypoint: string,
  outputDirectory: string,
): Promise<void> {
  const resolvedEntrypoint = resolve(entrypoint);
  const module = (await importTypeScript(
    pathToFileURL(resolvedEntrypoint).href,
  )) as Record<string, unknown>;
  const files = resolveRenderedFiles(module, resolvedEntrypoint);

  await installRenderedFiles(outputDirectory, files);
}

export async function copyProvisioningArtifacts(
  artifactsDirectory: string,
  outputDirectory: string,
): Promise<void> {
  const files = await readRenderedDirectory(artifactsDirectory);
  if (files.length === 0) {
    throw new Error(`Provisioning compiler produced no files in '${artifactsDirectory}'.`);
  }
  await installRenderedFiles(outputDirectory, files);
}

async function installRenderedFiles(
  outputDirectory: string,
  files: readonly RenderedFile[],
): Promise<void> {

  await mkdir(outputDirectory, { recursive: true });
  const manifestPath = resolve(outputDirectory, ".deploy-js-generated.json");
  for (const generatedPath of await readGeneratedManifest(manifestPath)) {
    await rm(resolveOutputPath(outputDirectory, generatedPath), { force: true });
  }
  await Promise.all(
    files.map(async (file) => {
      const outputPath = resolveOutputPath(outputDirectory, file.path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, file.contents);
    }),
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(files.map((file) => file.path).sort(), null, 2)}\n`,
  );
}

async function readRenderedDirectory(
  directory: string,
  root = directory,
): Promise<RenderedFile[]> {
  const files: RenderedFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await readRenderedDirectory(path, root)));
    } else if (entry.isFile()) {
      files.push({
        path: relative(root, path),
        contents: await readFile(path, "utf8"),
      });
    }
  }
  return files;
}

async function readGeneratedManifest(manifestPath: string): Promise<readonly string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`Invalid generated-file manifest: ${manifestPath}`);
    }
    return value;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function resolveOutputPath(outputDirectory: string, filePath: string): string {
  const outputPath = resolve(outputDirectory, filePath);
  const relativePath = relative(outputDirectory, outputPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Provisioning output escapes its directory: ${filePath}`);
  }
  return outputPath;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function resolveRenderedFiles(
  module: Record<string, unknown>,
  entrypoint: string,
): readonly RenderedFile[] {
  const defaultExport = module.default;
  const files =
    module.outputBicep ??
    (typeof defaultExport === "object" && defaultExport !== null
      ? (defaultExport as Record<string, unknown>).outputBicep
      : undefined);
  if (!Array.isArray(files) || files.length === 0 || !files.every(isRenderedFile)) {
    throw new Error(
      `Provisioning entrypoint '${entrypoint}' must export a non-empty outputBicep array.`,
    );
  }
  return files;
}

function isRenderedFile(value: unknown): value is RenderedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string" &&
    "contents" in value &&
    typeof value.contents === "string"
  );
}

async function collectBicepEnvironmentValues(
  parametersFile: string,
  overrides: Readonly<Record<string, string | number | boolean>> = {},
): Promise<Record<string, string | undefined>> {
  if (extname(parametersFile) !== ".bicepparam") {
    if (Object.keys(overrides).length > 0) {
      throw new Error(
        "Provisioning parameter overrides require a .bicepparam file.",
      );
    }
    return {};
  }
  const source = await readFile(parametersFile, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/readEnvironmentVariable\(\s*'([^']+)'/g)) {
    if (match[1]) names.add(match[1]);
  }
  const values: Record<string, string | undefined> = Object.fromEntries(
    [...names].map((name) => [name, process.env[name]]),
  );
  for (const [parameterName, parameterValue] of Object.entries(overrides)) {
    const escapedName = parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const binding = new RegExp(
      `^\\s*param\\s+${escapedName}(?:\\s+[^=\\r\\n]+)?\\s*=\\s*` +
        "readEnvironmentVariable\\(\\s*'([^']+)'",
      "m",
    ).exec(source);
    const environmentName = binding?.[1];
    if (!environmentName) {
      throw new Error(
        `Bicep parameter '${parameterName}' must bind directly to ` +
          "readEnvironmentVariable() for an azd provision override.",
      );
    }
    values[environmentName] = String(parameterValue);
  }
  return values;
}

function sanitizeAzdName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return sanitized || "deploy-js";
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}