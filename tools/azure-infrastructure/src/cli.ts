#!/usr/bin/env node

import { resolve } from "node:path";
import { createDeployment } from "iac-composer";
import {
  fetchAzureArchitectureCatalog,
  generateDeploymentCode,
  loadResourceRequirements,
  validateResourceRequirements,
  writeAzureArchitectureCatalog,
} from "./index.js";

interface GenerateOptions {
  command: "generate";
  resourcesFile: string;
  solutionFile: string;
  outputDirectory: string;
}

interface ValidateOptions {
  command: "validate";
  resourcesFile: string;
  subscriptionId?: string;
  tenantId?: string;
  principalId?: string;
  principalType?: string;
  resourceGroup?: string;
  scope?: string;
  grant: boolean;
}

interface ArchitectureCatalogOptions {
  command: "architecture-catalog";
  outputFile: string;
  ref: string;
  concurrency: number;
}

type CliOptions = GenerateOptions | ValidateOptions | ArchitectureCatalogOptions;

function parseArgs(args: readonly string[]): CliOptions {
  if (args[0] === "architecture-catalog") return parseArchitectureCatalogArgs(args.slice(1));
  if (args[0] === "generate") return parseGenerateArgs(args.slice(1));
  if (args[0] === "validate") return parseValidateArgs(args.slice(1));
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }
  throw new Error("Expected generate, validate, or architecture-catalog. Use --help for usage.");
}

function printHelp(): void {
  console.log(`Usage:
  azure-infrastructure generate --resources <requirements.json> --solution <solution.json> [options]
  azure-infrastructure validate --resources <requirements.json> [options]
  azure-infrastructure architecture-catalog [options]

Run authored deployment programs with iac-composer.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "architecture-catalog") {
    const catalog = await fetchAzureArchitectureCatalog({
      ref: options.ref,
      concurrency: options.concurrency,
      token: process.env.GITHUB_TOKEN,
    });
    await writeAzureArchitectureCatalog(catalog, options.outputFile);
    console.log(
      `[azure-infrastructure] extracted ${catalog.counts.architectures} Azure Architecture Center examples at ${catalog.source.commit}.`,
    );
    console.log(`[azure-infrastructure] wrote ${resolve(options.outputFile)}`);
    return;
  }
  if (options.command === "generate") {
    const result = await generateDeploymentCode({
      resourcesFile: options.resourcesFile,
      solutionFile: options.solutionFile,
      outputDirectory: options.outputDirectory,
      onProgress: (progress) => {
        console.log(
          `[azure-infrastructure] GENERATE ${progress.percent}% ${progress.message}`,
        );
      },
    });
    console.log(
      `[azure-infrastructure] generated ${result.files.length} files in ${resolve(options.outputDirectory)}`,
    );
    console.log(`[azure-infrastructure] component order: ${result.components.join(" -> ")}`);
    return;
  }
  if (options.command === "validate") {
    const requirements = await loadResourceRequirements(options.resourcesFile);
    const result = await validateResourceRequirements(createDeployment(), {
      requirements,
      subscriptionId:
        options.subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID,
      tenantId: options.tenantId ?? process.env.AZURE_TENANT_ID,
      principalId: options.principalId ?? process.env.AZURE_PRINCIPAL_ID,
      principalType:
        options.principalType ?? process.env.AZURE_PRINCIPAL_TYPE,
      resourceGroup:
        options.resourceGroup ?? process.env.AZURE_RESOURCE_GROUP,
      scope: options.scope,
      grant: options.grant,
    });
    for (const provider of result.providers) {
      console.log(
        `[azure-infrastructure] provider ${provider.namespace}: ${provider.registrationState}`,
      );
    }
    for (const role of result.roles) {
      console.log(
        `[azure-infrastructure] role ${role.role}: ${role.granted ? "granted" : role.present ? "present" : "missing"}`,
      );
    }
    const unregistered = result.providers.filter(
      (provider) => provider.registrationState !== "Registered",
    );
    const missingRoles = result.roles.filter((role) => !role.present);
    if (unregistered.length > 0 || missingRoles.length > 0) {
      const problems = [
        ...(unregistered.length > 0
          ? [`unregistered providers: ${unregistered.map(({ namespace }) => namespace).join(", ")}`]
          : []),
        ...(missingRoles.length > 0
          ? [`missing roles: ${missingRoles.map(({ role }) => role).join(", ")}`]
          : []),
      ];
      throw new Error(
        `Validation failed for '${result.scope}': ${problems.join("; ")}.` +
          (missingRoles.length > 0 && !options.grant
            ? " Rerun with --grant to assign missing roles."
            : ""),
      );
    }
    console.log(
      `[azure-infrastructure] validated deployment principal ${result.principalId} at ${result.scope}`,
    );
    return;
  }
}

function parseArchitectureCatalogArgs(
  args: readonly string[],
): ArchitectureCatalogOptions {
  let outputFile = "architecture-catalog.json";
  let ref = "main";
  let concurrency = 12;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-o" || argument === "--output") {
      outputFile = requiredValue(args, ++index, argument);
    } else if (argument === "--ref") {
      ref = requiredValue(args, ++index, argument);
    } else if (argument === "--concurrency") {
      const value = Number(requiredValue(args, ++index, argument));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--concurrency requires a positive integer.");
      }
      concurrency = value;
    } else if (argument === "-h" || argument === "--help") {
      printArchitectureCatalogHelp();
      process.exit(0);
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  return {
    command: "architecture-catalog",
    outputFile: resolve(outputFile),
    ref,
    concurrency,
  };
}

function parseGenerateArgs(args: readonly string[]): GenerateOptions {
  let resourcesFile: string | undefined;
  let solutionFile: string | undefined;
  let outputDirectory = "deployment";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-r" || argument === "--resources") {
      resourcesFile = requiredValue(args, ++index, argument);
    } else if (argument === "-s" || argument === "--solution") {
      solutionFile = requiredValue(args, ++index, argument);
    } else if (argument === "-o" || argument === "--output") {
      outputDirectory = requiredValue(args, ++index, argument);
    } else if (argument === "-h" || argument === "--help") {
      printGenerateHelp();
      process.exit(0);
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!resourcesFile) {
      resourcesFile = argument;
    } else if (!solutionFile) {
      solutionFile = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (!resourcesFile || !solutionFile) {
    printGenerateHelp();
    throw new Error("Resource requirements and solution files are required.");
  }
  return {
    command: "generate",
    resourcesFile: resolve(resourcesFile),
    solutionFile: resolve(solutionFile),
    outputDirectory: resolve(outputDirectory),
  };
}

function parseValidateArgs(args: readonly string[]): ValidateOptions {
  let resourcesFile: string | undefined;
  let subscriptionId: string | undefined;
  let tenantId: string | undefined;
  let principalId: string | undefined;
  let principalType: string | undefined;
  let resourceGroup: string | undefined;
  let scope: string | undefined;
  let grant = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-r" || argument === "--resources") {
      resourcesFile = requiredValue(args, ++index, argument);
    } else if (argument === "--subscription") {
      subscriptionId = requiredValue(args, ++index, argument);
    } else if (argument === "--tenant") {
      tenantId = requiredValue(args, ++index, argument);
    } else if (argument === "--principal-id") {
      principalId = requiredValue(args, ++index, argument);
    } else if (argument === "--principal-type") {
      principalType = requiredValue(args, ++index, argument);
    } else if (argument === "-g" || argument === "--resource-group") {
      resourceGroup = requiredValue(args, ++index, argument);
    } else if (argument === "--scope") {
      scope = requiredValue(args, ++index, argument);
    } else if (argument === "--grant") {
      grant = true;
    } else if (argument === "-h" || argument === "--help") {
      printValidateHelp();
      process.exit(0);
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!resourcesFile) {
      resourcesFile = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  if (!resourcesFile) {
    printValidateHelp();
    throw new Error("A resource requirements file is required.");
  }
  if (resourceGroup && scope) {
    throw new Error("Specify either --resource-group or --scope, not both.");
  }
  return {
    command: "validate",
    resourcesFile: resolve(resourcesFile),
    subscriptionId,
    tenantId,
    principalId,
    principalType,
    resourceGroup,
    scope,
    grant,
  };
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function printArchitectureCatalogHelp(): void {
  console.log(`Usage: azure-infrastructure architecture-catalog [options]

Options:
  -o, --output <file>        Catalog JSON file (default: architecture-catalog.json)
      --ref <git-ref>        MicrosoftDocs source ref (default: main)
      --concurrency <count>  Concurrent source requests (default: 12)
  -h, --help                 Show this help

Set GITHUB_TOKEN to increase GitHub API rate limits. The catalog records the
resolved source commit and Microsoft documentation and code licenses.`);
}

function printGenerateHelp(): void {
  console.log(`Usage: azure-infrastructure generate [options]

Options:
  -r, --resources <file>     Resource requirements JSON file
  -s, --solution <file>      Deployment solution JSON file
  -o, --output <directory>   Generated source directory (default: deployment)
  -h, --help                 Show this help

The two input files may also be passed positionally in resources, solution order.`);
}

function printValidateHelp(): void {
  console.log(`Usage: azure-infrastructure validate --resources <requirements.json> [options]

Options:
  -r, --resources <file>       Resource requirements JSON file
      --subscription <id>      Azure subscription (defaults to active account)
      --tenant <id>            Require the subscription to use this tenant
      --principal-id <id>      Deployment principal object ID (defaults to signed-in user)
      --principal-type <type>  Azure principal type (default: User)
  -g, --resource-group <name>  Validate at this resource-group scope
      --scope <resource-id>    Validate at an explicit Azure scope
      --grant                  Assign missing deployment data-plane roles
  -h, --help                   Show this help`);
}

main().catch((error: unknown) => {
  console.error(`[azure-infrastructure] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});