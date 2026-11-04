#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDeployment,
  type DeploymentProgram,
} from "./index.js";
import { isIacComposerAzdTemplate } from "./azd.js";
import { importTypeScript } from "./typescript-loader.js";
import { diagnosticFor, IacComposerError } from "./diagnostics.js";
import { describe } from "./discovery.js";
import {
  createExecutionReport,
  recordDeploymentEvent,
  writeExecutionReport,
  type ExecutionReport,
} from "./report.js";

interface RunOptions {
  command: "run";
  file: string;
  environment?: string;
  projectDirectory?: string;
  component?: string;
  dryRun: boolean;
}

interface DownOptions {
  command: "down";
  projectDirectory: string;
  environment: string;
  force: true;
  purge: boolean;
}

type CliOptions = RunOptions | DownOptions |
  { command: "describe"; topic: string } |
  { command: "help"; topic: "run" | "down" };

async function main(): Promise<void> {
  const { args, reportPath } = extractReportOption(process.argv.slice(2));
  const report = createExecutionReport();
  // Fail before importing authored code or running commands if the report cannot be written.
  if (reportPath) await writeExecutionReport(reportPath, report);
  try {
    const options = parseArgs(args);
    report.command = options.command;
    if (options.command === "help") {
      if (options.topic === "down") printDownHelp();
      else printHelp();
    } else if (options.command === "describe") {
      const description = describe(options.topic);
      if (!description) {
        throw usageError(
          "DISCOVERY_TOPIC_UNKNOWN",
          `Unknown discovery topic: ${options.topic}`,
          "Use overview, commands, provisioning, or report.",
        );
      }
      console.log(JSON.stringify(description, null, 2));
    } else {
      report.dryRun = options.command === "run" ? options.dryRun : false;
      await executeOptions(options, report);
    }
    report.status = "succeeded";
  } catch (error) {
    report.status = "failed";
    report.diagnostics.push(diagnosticFor(error));
    console.error(`[iac-composer] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  if (reportPath) await writeExecutionReport(reportPath, report);
}

async function executeOptions(
  options: RunOptions | DownOptions,
  report: ExecutionReport,
): Promise<void> {
  const onEvent = (event: Parameters<typeof recordDeploymentEvent>[1]) =>
    recordDeploymentEvent(report, event);
  if (options.command === "down") {
    await verifyIacComposerProject(options.projectDirectory);
    const deployment = createDeployment({
      projectDirectory: options.projectDirectory,
      environment: options.environment,
      onEvent,
    });
    await deployment.run("delete generated project resources", {
      command: "azd",
      args: [
        "down",
        "--environment",
        options.environment,
        "--force",
        ...(options.purge ? ["--purge"] : []),
        "--no-prompt",
      ],
    });
    return;
  }
  const file = resolve(options.file);
  let module: { default?: DeploymentProgram };
  try {
    module = (await importTypeScript(pathToFileURL(file).href)) as {
      default?: DeploymentProgram;
    };
  } catch (error) {
    if (error instanceof IacComposerError) throw error;
    throw new IacComposerError({
      code: "DEPLOYMENT_LOAD_FAILED",
      category: "compilation",
      message: `Could not load deployment file '${file}'.`,
      target: file,
      repair: "Check the file path, module syntax, package module type, and installed imports. Run the project's typecheck for TypeScript diagnostics.",
    }, { cause: error, message: error instanceof Error ? error.message : String(error) });
  }
  if (typeof module.default !== "function") {
    throw new IacComposerError({
      code: "DEPLOYMENT_EXPORT_INVALID",
      category: "compilation",
      message: `Deployment file '${file}' must export a default async function.`,
      target: file,
      property: "default",
      repair: "Default-export defineDeployment(async (deployment) => { ... }).",
    });
  }

  const deployment = createDeployment({
    projectDirectory: options.projectDirectory,
    environment: options.environment,
    component: options.component,
    dryRun: options.dryRun,
    onEvent,
  });
  await module.default(deployment);
}

function parseArgs(args: readonly string[]): CliOptions {
  if (["architecture-catalog", "generate", "validate"].includes(args[0] ?? "")) {
    throw usageError(
      "COMMAND_DELEGATED",
      `'${args[0]}' belongs to the separate azure-infrastructure tool.`,
      `Use azure-infrastructure ${args[0]} --help; iac-composer executes authored deployment programs.`,
    );
  }
  if (args[0] === "describe") {
    const descriptionArgs = args.slice(1).filter((argument) => argument !== "--json");
    if (descriptionArgs.length > 1 || descriptionArgs[0]?.startsWith("-")) {
      throw usageError("ARGUMENT_UNEXPECTED", "Unexpected discovery argument.", "Use iac-composer describe [overview|commands|provisioning|report] --json.");
    }
    return { command: "describe", topic: descriptionArgs[0] ?? "overview" };
  }
  if (args[0] === "down") return parseDownArgs(args.slice(1));
  return parseRunArgs(args[0] === "run" ? args.slice(1) : args);
}

function parseDownArgs(args: readonly string[]): DownOptions | { command: "help"; topic: "down" } {
  let projectDirectory: string | undefined;
  let environment: string | undefined;
  let force = false;
  let purge = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-e" || argument === "--environment") {
      environment = requiredValue(args, ++index, argument);
    } else if (argument === "-C" || argument === "--cwd") {
      projectDirectory = requiredValue(args, ++index, argument);
    } else if (argument === "--force") {
      force = true;
    } else if (argument === "--purge") {
      purge = true;
    } else if (argument === "-h" || argument === "--help") {
      return { command: "help", topic: "down" };
    } else if (argument?.startsWith("-")) {
      throw usageError("OPTION_UNKNOWN", `Unknown option: ${argument}`, "Use iac-composer down --help for supported options.");
    } else if (!projectDirectory) {
      projectDirectory = argument;
    } else {
      throw usageError("ARGUMENT_UNEXPECTED", `Unexpected argument: ${argument}`, "Supply one generated project directory.");
    }
  }

  if (!projectDirectory) {
    printDownHelp();
    throw usageError("PROJECT_DIRECTORY_REQUIRED", "A generated azd project directory is required.", "Supply the generated project directory as a positional argument or --cwd.");
  }
  if (!environment) {
    throw usageError("CLEANUP_ENVIRONMENT_REQUIRED", "Cleanup requires an explicit --environment value.", "Select the environment explicitly with --environment <name>.");
  }
  if (!force) {
    throw usageError("CLEANUP_CONFIRMATION_REQUIRED", "Cleanup requires --force to confirm resource deletion.", "Obtain explicit approval for resource deletion before adding --force.");
  }
  return {
    command: "down",
    projectDirectory: resolve(projectDirectory),
    environment,
    force: true,
    purge,
  };
}

function parseRunArgs(args: readonly string[]): RunOptions | { command: "help"; topic: "run" } {
  let file: string | undefined;
  let environment: string | undefined;
  let projectDirectory: string | undefined;
  let component: string | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "-e" || argument === "--environment") {
      environment = requiredValue(args, ++index, argument);
    } else if (argument === "-C" || argument === "--cwd") {
      projectDirectory = requiredValue(args, ++index, argument);
    } else if (argument === "-c" || argument === "--component") {
      component = requiredValue(args, ++index, argument);
    } else if (argument === "-h" || argument === "--help") {
      return { command: "help", topic: "run" };
    } else if (argument?.startsWith("-")) {
      throw usageError("OPTION_UNKNOWN", `Unknown option: ${argument}`, "Use iac-composer --help for supported options.");
    } else if (!file) {
      file = argument;
    } else {
      throw usageError("ARGUMENT_UNEXPECTED", `Unexpected argument: ${argument}`, "Supply one authored deployment file.");
    }
  }

  if (!file) {
    printHelp();
    throw usageError("DEPLOYMENT_FILE_REQUIRED", "A deployment file is required.", "Supply a TypeScript or JavaScript deployment file.");
  }
  return {
    command: "run",
    file,
    environment,
    projectDirectory,
    component,
    dryRun,
  };
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value?.trim() || value.startsWith("-")) {
    throw usageError("OPTION_VALUE_REQUIRED", `${option} requires a value.`, `Supply a non-empty value immediately after ${option}.`, option);
  }
  return value;
}

function usageError(code: string, message: string, repair: string, property?: string): IacComposerError {
  return new IacComposerError({ code, category: "usage", message, repair, ...(property ? { property } : {}) });
}

function extractReportOption(args: readonly string[]): { args: string[]; reportPath?: string } {
  const remaining: string[] = [];
  let reportPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--report") {
      if (reportPath) throw usageError("OPTION_DUPLICATE", "--report may only be specified once.", "Supply one report destination.");
      reportPath = resolve(requiredValue(args, ++index, "--report"));
    } else {
      remaining.push(args[index]!);
    }
  }
  return { args: remaining, reportPath };
}

async function verifyIacComposerProject(projectDirectory: string): Promise<void> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(resolve(projectDirectory, "azure.yaml"), "utf8"),
    );
  } catch {
    throw cleanupError(projectDirectory, `Refusing cleanup: '${projectDirectory}' is not a generated iac-composer azd project.`);
  }
  const metadata = readObjectProperty(manifest, "metadata");
  const infra = readObjectProperty(manifest, "infra");
  if (
    typeof metadata?.template === "string" &&
    metadata.template.startsWith("imperative-deploy@")
  ) {
    throw cleanupError(projectDirectory,
      `Refusing cleanup: '${projectDirectory}' is a legacy imperative-deploy project. ` +
        "Regenerate it with iac-composer before cleanup.",
    );
  }
  if (
    !isIacComposerAzdTemplate(metadata?.template) ||
    !Array.isArray(infra?.layers) ||
    infra.layers.length === 0
  ) {
    throw cleanupError(projectDirectory,
      `Refusing cleanup: '${projectDirectory}' is not a layered iac-composer project.`,
    );
  }
}

function cleanupError(projectDirectory: string, message: string): IacComposerError {
  return new IacComposerError({
    code: "CLEANUP_PROJECT_UNVERIFIED",
    category: "configuration",
    message,
    target: projectDirectory,
    repair: "Select an existing generated layered project owned by iac-composer. Regenerate legacy projects; do not forge ownership metadata.",
  });
}

function readObjectProperty(
  value: unknown,
  property: string,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "object" &&
    propertyValue !== null &&
    !Array.isArray(propertyValue)
    ? (propertyValue as Record<string, unknown>)
    : undefined;
}

function printHelp(): void {
  console.log(`Usage:
  iac-composer <deployment.ts> [options]
    iac-composer describe [overview|commands|provisioning|report] --json
  iac-composer down <generated-project-directory> --environment <name> --force [options]

Composition options:
  -e, --environment <name>  Select the deployment environment
  -C, --cwd <directory>     Set the deployment working directory
  -c, --component <name>    Run one deployment-defined component
      --dry-run             Compile local artifacts; skip wrapped Azure/app actions
      --report <path>       Write a machine-readable JSON result (including failures)
  -h, --help                Show this help`);
}

function printDownHelp(): void {
  console.log(`Usage: iac-composer down <generated-project-directory> --environment <name> --force [options]

Options:
  -e, --environment <name>  Select the azd environment to delete
  -C, --cwd <directory>     Generated iac-composer azd project directory
      --force               Confirm deletion and disable azd prompts (required)
      --purge               Permanently delete soft-deleted resources
      --report <path>       Write a machine-readable JSON result (including failures)
  -h, --help                Show this help`);
}

main().catch((error: unknown) => {
  console.error(`[iac-composer] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});