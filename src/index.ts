import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
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
import { getAzdProject, iacComposerAzdTemplate } from "./azd.js";
import { importTypeScript } from "./typescript-loader.js";
import { IacComposerError } from "./diagnostics.js";
import type { DeploymentEvent, StepEvent } from "./report.js";

export { IacComposerError, type Diagnostic } from "./diagnostics.js";
export type { DeploymentEvent, StepEvent, ArtifactEvent, ExecutionReport } from "./report.js";
export { describe as describeRuntimeCapabilities, type DiscoveryTopic } from "./discovery.js";
export {
  getIacComposerContext,
  implementationTopics,
  type ImplementationTopic,
} from "./authoring-context.js";
export { getTypeScriptReference, type TypeScriptReference } from "./sdk-reference.js";
export {
  createWorkspacePaths,
  containsPath,
  workspaceError,
  type WorkspacePaths,
} from "./workspace.js";

export {
  AzdProject,
  createAzdProject,
  iacComposerAzdTemplate,
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
  onEvent?: (event: DeploymentEvent) => void;
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
  #events: { nextId: number; onEvent?: (event: DeploymentEvent) => void };

  constructor(options: DeploymentOptions = {}) {
    this.projectDirectory = resolve(options.projectDirectory ?? process.cwd());
    this.environment = options.environment;
    this.component = options.component;
    this.dryRun = options.dryRun ?? false;
    this.#log = options.log ?? console.log;
    this.#events = { nextId: 0, onEvent: options.onEvent };
  }

  inDirectory(projectDirectory: string): Deployment {
    const child = new Deployment({
      projectDirectory,
      environment: this.environment,
      component: this.component,
      dryRun: this.dryRun,
      log: this.#log,
    });
    child.#events = this.#events;
    return child;
  }

  async env(name: string, values: NodeJS.ProcessEnv): Promise<void> {
    await this.#step("env", name, async () => {
      Object.assign(process.env, values);
    });
  }

  async provision(name: string, options: ProvisionOptions): Promise<ProvisionOutputs> {
    let outputs: ProvisionOutputs = {};
    await this.#step("provision", name, async () => {
      validateProvisionOptions(options);
      const outputDirectory = resolve(
        this.projectDirectory,
        options.layer?.outputDirectory ??
          options.outputDirectory ??
          await defaultProvisioningDirectory(this.projectDirectory),
      );
      const layer = inferLayerName(outputDirectory);
      const azdProjectDirectory = layer ? dirname(outputDirectory) : outputDirectory;
      const entrypoint = options.layer?.entrypoint ?? options.entrypoint;
      const requiredFiles = [
        options.templateFile ?? "main.bicep",
        options.parametersFile ?? "main.bicepparam",
      ];
      if (options.compiler && options.artifactsDirectory) {
        await this.#execute(options.compiler);
        await copyProvisioningArtifacts(
          resolve(this.projectDirectory, options.artifactsDirectory),
          outputDirectory,
          azdProjectDirectory,
          requiredFiles,
        );
      } else if (entrypoint) {
        await compileProvisioning(
          resolve(this.projectDirectory, entrypoint),
          outputDirectory,
          azdProjectDirectory,
          requiredFiles,
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
        await rm(resolve(azdProjectDirectory, ".iac-composer-project.json"), {
          force: true,
        });
        await rm(resolve(azdProjectDirectory, ".iac-compose-project.json"), {
          force: true,
        });
      }
      const project = getAzdProject(this, {
        directory: azdProjectDirectory,
        mergeManifest: layer !== undefined,
        manifest: {
          name: sanitizeAzdName(
            options.deploymentName ?? basename(outputDirectory),
          ),
          ...(layer ? { metadata: { template: iacComposerAzdTemplate } } : {}),
          ...(layer ? { requiredVersions: { azd: ">= 1.30.0" } } : {}),
          infra,
        },
        subscription:
          options.subscription ?? process.env.AZURE_SUBSCRIPTION_ID,
        location: options.location ?? process.env.AZURE_LOCATION,
        values: environmentValues,
      });
      this.#events.onEvent?.({
        type: "artifacts",
        step: name,
        projectDirectory: azdProjectDirectory,
        outputDirectory,
        templateFile,
        parametersFile,
        manifestFile: resolve(azdProjectDirectory, "azure.yaml"),
        ...(layer ? { layer } : {}),
        dependsOn,
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
    this.#log(`[iac-composer] $ ${formatCommand(command.command, command.args ?? [])}`);
    if (this.dryRun) return;
    await this.#execute(command, false, false);
  }

  async capture(command: Command): Promise<string> {
    this.#log(`[iac-composer] $ ${formatCommand(command.command, command.args ?? [])}`);
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
    kind: StepEvent["kind"],
    name: string,
    action: () => Promise<void>,
    runInDryRun = false,
  ): Promise<void> {
    this.#log(`[iac-composer] ${this.dryRun ? "DRY" : "RUN"} ${kind}: ${name}`);
    const step = {
      type: "step" as const,
      id: ++this.#events.nextId,
      kind,
      name,
      projectDirectory: this.projectDirectory,
    };
    if (this.dryRun && !runInDryRun) {
      this.#events.onEvent?.({ ...step, status: "skipped" });
      return;
    }
    this.#events.onEvent?.({ ...step, status: "started" });
    try {
      await action();
    } catch (error) {
      this.#events.onEvent?.({ ...step, status: "failed" });
      throw error;
    }
    this.#events.onEvent?.({ ...step, status: this.dryRun ? "previewed" : "succeeded" });
    if (!this.dryRun) this.#log(`[iac-composer] DONE ${kind}: ${name}`);
  }

  async #execute(command: Command, capture = false, log = true): Promise<string> {
    const args = [...(command.args ?? [])];
    if (log) this.#log(`[iac-composer] $ ${formatCommand(command.command, args)}`);

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
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(new IacComposerError({
          code: error.code === "ENOENT" ? "COMMAND_NOT_FOUND" : "COMMAND_START_FAILED",
          category: "execution",
          message: `Could not start '${command.command}'.`,
          target: command.command,
          repair: "Check that the executable is installed, the working directory exists, and permissions allow execution.",
        }, { cause: error, message: error.message }));
      });
      child.on("exit", (code, signal) => {
        if (code === 0) {
          resolvePromise(stdout);
          return;
        }
        reject(
          new IacComposerError({
            code: "COMMAND_FAILED",
            category: "execution",
            message: `${command.command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
            target: command.command,
            exitCode: code,
            ...(signal ? { signal } : {}),
            repair: "Inspect stderr and the failed step. Check external state before retrying; completed actions are not rolled back.",
          }, {
            message: `${command.command} exited with ${signal ? `signal ${signal}` : `code ${code}`}` +
              (stderr.trim() ? `: ${stderr.trim()}` : ""),
          }),
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

function validateProvisionOptions(options: ProvisionOptions): void {
  let message: string | undefined;
  if (
    options.layer &&
    [options.entrypoint, options.outputDirectory, options.compiler, options.artifactsDirectory]
      .some((value) => value !== undefined)
  ) {
    message = "Provisioning with a layer cannot also specify source or output options.";
  } else if (
    options.entrypoint !== undefined &&
    (options.compiler !== undefined || options.artifactsDirectory !== undefined)
  ) {
    message = "Provisioning cannot combine an entrypoint with compiler or artifactsDirectory.";
  } else if (
    (options.compiler !== undefined) !== (options.artifactsDirectory !== undefined)
  ) {
    message = "Provisioning with a compiler requires both compiler and artifactsDirectory.";
  } else if (!options.layer?.entrypoint && !options.entrypoint && !options.compiler) {
    message = "Provisioning requires either an entrypoint or a compiler with artifactsDirectory.";
  }
  if (message) {
    throw new IacComposerError({
      code: "PROVISION_SOURCE_INVALID",
      category: "configuration",
      message,
      property: "provision",
      expected: "Exactly one source: layer, entrypoint, or compiler with artifactsDirectory.",
      repair: "Choose one provisioning source and remove conflicting options.",
    });
  }
}

function validateRenderedFiles(
  outputDirectory: string,
  files: readonly RenderedFile[],
  requiredFiles: readonly string[],
): void {
  const paths = new Set<string>();
  for (const file of files) {
    const path = resolveOutputPath(outputDirectory, file.path);
    if (paths.has(path)) {
      throw new IacComposerError({
        code: "ARTIFACT_PATH_DUPLICATE",
        category: "artifact",
        message: `Provisioning produced duplicate output path '${file.path}'.`,
        target: file.path,
        property: "outputBicep.path",
        repair: "Emit each normalized file path only once.",
      });
    }
    paths.add(path);
  }
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== outputDirectory) {
      if (paths.has(parent)) {
        throw new IacComposerError({
          code: "ARTIFACT_PATH_CONFLICT",
          category: "artifact",
          message: `Provisioning output '${parent}' is both a file and a directory.`,
          target: parent,
          property: "outputBicep.path",
          repair: "Rename the conflicting file or place nested files in a different directory.",
        });
      }
      parent = dirname(parent);
    }
  }
  for (const file of requiredFiles) {
    if (!paths.has(resolveOutputPath(outputDirectory, file))) {
      throw new IacComposerError({
        code: "ARTIFACT_REQUIRED",
        category: "artifact",
        message: `Provisioning did not emit required artifact '${file}'.`,
        target: file,
        expected: "The selected templateFile and parametersFile must exist in the rendered output.",
        repair: "Emit this file from the provisioning source, or set templateFile/parametersFile to an emitted path.",
      });
    }
  }
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
  generatedFilesRoot = outputDirectory,
  requiredFiles: readonly string[] = [],
): Promise<void> {
  const resolvedEntrypoint = resolve(entrypoint);
  let module: Record<string, unknown>;
  try {
    module = (await importTypeScript(
      pathToFileURL(resolvedEntrypoint).href,
    )) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof IacComposerError) throw error;
    throw new IacComposerError({
      code: "PROVISIONING_LOAD_FAILED",
      category: "compilation",
      message: `Could not load provisioning entrypoint '${resolvedEntrypoint}'.`,
      target: resolvedEntrypoint,
      repair: "Check the entrypoint path, syntax, package module type, and provisioning SDK dependencies; run the project's typecheck.",
    }, { cause: error, message: error instanceof Error ? error.message : String(error) });
  }
  const files = resolveRenderedFiles(module, resolvedEntrypoint);

  await installRenderedFiles(outputDirectory, files, generatedFilesRoot, requiredFiles);
}

export async function copyProvisioningArtifacts(
  artifactsDirectory: string,
  outputDirectory: string,
  generatedFilesRoot = outputDirectory,
  requiredFiles: readonly string[] = [],
): Promise<void> {
  const files = await readRenderedDirectory(artifactsDirectory);
  if (files.length === 0) {
    throw new IacComposerError({
      code: "ARTIFACTS_EMPTY",
      category: "artifact",
      message: `Provisioning compiler produced no files in '${artifactsDirectory}'.`,
      target: artifactsDirectory,
      repair: "Configure the compiler to emit Bicep artifacts into artifactsDirectory.",
    });
  }
  await installRenderedFiles(outputDirectory, files, generatedFilesRoot, requiredFiles);
}

async function installRenderedFiles(
  outputDirectory: string,
  files: readonly RenderedFile[],
  generatedFilesRoot: string,
  requiredFiles: readonly string[],
): Promise<void> {
  outputDirectory = resolve(outputDirectory);
  generatedFilesRoot = resolve(generatedFilesRoot);
  validateRenderedFiles(outputDirectory, files, requiredFiles);
  relativeGeneratedPath(generatedFilesRoot, outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(generatedFilesRoot, { recursive: true });
  await rejectLegacyGeneratedManifest(
    resolve(generatedFilesRoot, ".deploy-js-generated.json"),
  );
  const manifestPath = resolve(generatedFilesRoot, ".iac-composer-generated.json");
  const previousManifestPath = resolve(generatedFilesRoot, ".iac-compose-generated.json");
  const generatedPaths = new Set([
    ...(await readGeneratedManifest(previousManifestPath)),
    ...(await readGeneratedManifest(manifestPath)),
  ]);
  let migratedLayerManifests: string[] = [];
  if (generatedFilesRoot !== outputDirectory) {
    migratedLayerManifests = await migrateLayerGeneratedManifests(
      generatedFilesRoot,
      generatedPaths,
    );
  }
  for (const generatedPath of generatedPaths) {
    resolveOutputPath(generatedFilesRoot, generatedPath);
  }

  const outputPrefix = relativeGeneratedPath(generatedFilesRoot, outputDirectory);
  const scopedPrefix = outputPrefix ? `${outputPrefix}/` : "";
  for (const generatedPath of [...generatedPaths]) {
    if (scopedPrefix && !generatedPath.startsWith(scopedPrefix)) continue;
    await rm(resolveOutputPath(generatedFilesRoot, generatedPath), { force: true });
    generatedPaths.delete(generatedPath);
  }
  await Promise.all(
    files.map(async (file) => {
      const outputPath = resolveOutputPath(outputDirectory, file.path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, file.contents);
    }),
  );
  for (const file of files) {
    generatedPaths.add(
      relativeGeneratedPath(
        generatedFilesRoot,
        resolveOutputPath(outputDirectory, file.path),
      ),
    );
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify([...generatedPaths].sort(), null, 2)}\n`,
  );
  await Promise.all(
    [previousManifestPath, ...migratedLayerManifests].map((path) =>
      rm(path, { force: true }),
    ),
  );
}

async function migrateLayerGeneratedManifests(
  generatedFilesRoot: string,
  generatedPaths: Set<string>,
): Promise<string[]> {
  const migratedManifests: string[] = [];
  for (const entry of await readdir(generatedFilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const layerDirectory = resolve(generatedFilesRoot, entry.name);
    await rejectLegacyGeneratedManifest(
      resolve(layerDirectory, ".deploy-js-generated.json"),
    );
    const manifestPath = resolve(layerDirectory, ".iac-composer-generated.json");
    const previousManifestPath = resolve(layerDirectory, ".iac-compose-generated.json");
    const layerPaths = [
      ...(await readGeneratedManifest(previousManifestPath)),
      ...(await readGeneratedManifest(manifestPath)),
    ];
    for (const generatedPath of layerPaths) {
      generatedPaths.add(
        relativeGeneratedPath(
          generatedFilesRoot,
          resolveOutputPath(layerDirectory, generatedPath),
        ),
      );
    }
    migratedManifests.push(previousManifestPath, manifestPath);
  }
  return migratedManifests;
}

async function defaultProvisioningDirectory(projectDirectory: string): Promise<string> {
  const previousRoot = resolve(projectDirectory, ".iac-compose");
  const previous = resolve(previousRoot, "infra");
  const current = resolve(projectDirectory, ".iac-composer", "infra");
  try {
    await readdir(previous);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return current;
    throw error;
  }
  try {
    await readdir(current);
    throw new Error(
      "Both .iac-compose/infra and .iac-composer/infra exist. " +
        "Specify outputDirectory explicitly to select the provisioning state.",
    );
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(current), { recursive: true });
  await rename(previous, current);
  if ((await readdir(previousRoot)).length === 0) {
    await rmdir(previousRoot);
  }
  return current;
}

async function rejectLegacyGeneratedManifest(path: string): Promise<void> {
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `Legacy deploy-js generated output detected at '${path}'. ` +
      "Remove the generated output directory and rerun iac-composer.",
  );
}

function relativeGeneratedPath(root: string, path: string): string {
  const generatedPath = relative(root, path);
  if (
    isAbsolute(generatedPath) ||
    generatedPath === ".." ||
    generatedPath.startsWith(`..${sep}`)
  ) {
    throw new Error(`Generated provisioning output '${path}' must be inside '${root}'.`);
  }
  return generatedPath.split(sep).join("/");
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
  if (
    !filePath.trim() ||
    isAbsolute(filePath) ||
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new IacComposerError({
      code: "ARTIFACT_PATH_INVALID",
      category: "artifact",
      message: `Provisioning output escapes its directory or has an invalid path: ${filePath}`,
      target: filePath,
      property: "outputBicep.path",
      expected: "A non-empty relative file path inside the output directory.",
      repair: "Correct the authored output path; do not modify generated artifacts.",
    });
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
    throw new IacComposerError({
      code: "OUTPUT_BICEP_INVALID",
      category: "compilation",
      message: `Provisioning entrypoint '${entrypoint}' must export a non-empty outputBicep array.`,
      target: entrypoint,
      property: "outputBicep",
      expected: "A non-empty array of { path: string, contents: string }.",
      repair: "Export rendered Bicep files as outputBicep from the provisioning entrypoint.",
    });
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
      throw new IacComposerError({
        code: "PARAMETER_FILE_UNSUPPORTED",
        category: "configuration",
        message: "Provisioning parameter overrides require a .bicepparam file.",
        target: parametersFile,
        property: "parametersFile",
        repair: "Use a .bicepparam file for parameter overrides.",
      });
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
      throw new IacComposerError({
        code: "PARAMETER_BINDING_REQUIRED",
        category: "configuration",
        message: `Bicep parameter '${parameterName}' must bind directly to readEnvironmentVariable() for an azd provision override.`,
        target: parametersFile,
        property: `parameters.${parameterName}`,
        repair: "Bind this parameter directly to readEnvironmentVariable() in the authored parameter source, or remove the override.",
      });
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
  return sanitized || "iac-composer";
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}