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

type CliOptions = RunOptions | DownOptions;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "down") {
    await verifyIacComposerProject(options.projectDirectory);
    const deployment = createDeployment({
      projectDirectory: options.projectDirectory,
      environment: options.environment,
    });
    await deployment.execute({
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
  const module = (await importTypeScript(pathToFileURL(file).href)) as {
    default?: DeploymentProgram;
  };
  if (typeof module.default !== "function") {
    throw new Error(`Deployment file '${file}' must export a default async function.`);
  }

  const deployment = createDeployment({
    projectDirectory: options.projectDirectory,
    environment: options.environment,
    component: options.component,
    dryRun: options.dryRun,
  });
  await module.default(deployment);
}

function parseArgs(args: readonly string[]): CliOptions {
  if (["architecture-catalog", "generate", "validate"].includes(args[0] ?? "")) {
    throw new Error(`'${args[0]}' belongs to the separate azure-infrastructure tool.`);
  }
  if (args[0] === "down") return parseDownArgs(args.slice(1));
  return parseRunArgs(args[0] === "run" ? args.slice(1) : args);
}

function parseDownArgs(args: readonly string[]): DownOptions {
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
      printDownHelp();
      process.exit(0);
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!projectDirectory) {
      projectDirectory = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (!projectDirectory) {
    printDownHelp();
    throw new Error("A generated azd project directory is required.");
  }
  if (!environment) {
    throw new Error("Cleanup requires an explicit --environment value.");
  }
  if (!force) {
    throw new Error("Cleanup requires --force to confirm resource deletion.");
  }
  return {
    command: "down",
    projectDirectory: resolve(projectDirectory),
    environment,
    force: true,
    purge,
  };
}

function parseRunArgs(args: readonly string[]): RunOptions {
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
      printHelp();
      process.exit(0);
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!file) {
      file = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (!file) {
    printHelp();
    throw new Error("A deployment file is required.");
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
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

async function verifyIacComposerProject(projectDirectory: string): Promise<void> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(resolve(projectDirectory, "azure.yaml"), "utf8"),
    );
  } catch {
    throw new Error(
      `Refusing cleanup: '${projectDirectory}' is not a generated iac-composer azd project.`,
    );
  }
  const metadata = readObjectProperty(manifest, "metadata");
  const infra = readObjectProperty(manifest, "infra");
  if (
    typeof metadata?.template === "string" &&
    metadata.template.startsWith("imperative-deploy@")
  ) {
    throw new Error(
      `Refusing cleanup: '${projectDirectory}' is a legacy imperative-deploy project. ` +
        "Regenerate it with iac-composer before cleanup.",
    );
  }
  if (
    !isIacComposerAzdTemplate(metadata?.template) ||
    !Array.isArray(infra?.layers) ||
    infra.layers.length === 0
  ) {
    throw new Error(
      `Refusing cleanup: '${projectDirectory}' is not a layered iac-composer project.`,
    );
  }
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
  iac-composer down <generated-project-directory> --environment <name> --force [options]

Composition options:
  -e, --environment <name>  Select the deployment environment
  -C, --cwd <directory>     Set the deployment working directory
  -c, --component <name>    Run one deployment-defined component
      --dry-run             Print ordered steps without side effects
  -h, --help                Show this help`);
}

function printDownHelp(): void {
  console.log(`Usage: iac-composer down <generated-project-directory> --environment <name> --force [options]

Options:
  -e, --environment <name>  Select the azd environment to delete
  -C, --cwd <directory>     Generated iac-composer azd project directory
      --force               Confirm deletion and disable azd prompts (required)
      --purge               Permanently delete soft-deleted resources
  -h, --help                Show this help`);
}

main().catch((error: unknown) => {
  console.error(`[iac-composer] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});