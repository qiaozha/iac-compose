#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDeployment, type DeploymentProgram } from "./index.js";
import { importTypeScript } from "./typescript-loader.js";

interface CliOptions {
  file: string;
  environment?: string;
  projectDirectory?: string;
  dryRun: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
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
    dryRun: options.dryRun,
  });
  await module.default(deployment);
}

function parseArgs(args: readonly string[]): CliOptions {
  let file: string | undefined;
  let environment: string | undefined;
  let projectDirectory: string | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "run") continue;
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "-e" || argument === "--environment") {
      environment = requiredValue(args, ++index, argument);
    } else if (argument === "-C" || argument === "--cwd") {
      projectDirectory = requiredValue(args, ++index, argument);
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
  return { file, environment, projectDirectory, dryRun };
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: deploy-js run <deployment.ts> [options]

Options:
  -e, --environment <name>  Select the deployment environment
  -C, --cwd <directory>     Set the deployment working directory
      --dry-run             Print ordered steps without side effects
  -h, --help                Show this help`);
}

main().catch((error: unknown) => {
  console.error(`[deploy-js] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});