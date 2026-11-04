import { executionReportSchema } from "./report.js";

const runOptions = {
  "--environment": { aliases: ["-e"], type: "string", required: false },
  "--cwd": { aliases: ["-C"], type: "string", default: "process.cwd()", description: "Working directory for provisioning paths and commands; the deployment file is resolved from the invoking directory." },
  "--component": { aliases: ["-c"], type: "string", description: "Authored program selector; does not automatically include prerequisites." },
  "--dry-run": { type: "boolean", default: false, description: "Compile and write local artifacts; skip wrapped application actions and azd execution." },
  "--report": { type: "string", description: "Write a versioned JSON result to this file; parent directory must exist. Human logs remain on stdout/stderr." },
  "--help": { aliases: ["-h"], type: "boolean" },
};

const topics = {
  overview: {
    purpose: "Implement Azure infrastructure as TypeScript with Azure provisioning libraries, then compose provisioning and application deployment in authored order.",
    topics: ["overview", "commands", "provisioning", "report"],
    resources: {
      catalog: null,
      source: "Customer-selected @azure/provisioning-* packages or a custom compiler exporting Bicep artifacts.",
      planningRequired: false,
      planningInput: "Resource requirements from the user, repository evidence, or any planning workflow; no planner-specific JSON contract is required.",
      delegatedCommands: ["generate", "validate", "architecture-catalog"],
    },
    authoring: {
      preferredLanguage: "TypeScript",
      libraries: "@azure/provisioning-*",
      sourceOfTruth: "Customer-owned TypeScript resource definitions and deployment program.",
      artifacts: "Generated Bicep, parameters and azd manifest; not the default handwritten source.",
      composition: "defineDeployment, typed resource references, returned outputs and ordered deployment helpers.",
    },
    agentInterfaces: {
      skill: "iac-composer",
      mcp: "iac-composer-mcp",
      contextTool: "iac_composer_get_context",
      referenceTool: "iac_composer_get_reference",
    },
    limitations: [
      "No intent inference, resource catalog, contract generation, automatic output wiring, or resource dependency graph in this runtime.",
      "Dry run is local compilation, not a Bicep typecheck, Azure what-if, permission check, or deployment guarantee.",
      "Authored modules and custom compilers execute during preview. Only actions wrapped in deployment APIs are skipped.",
      "Dry run returns empty provision outputs and skips deployment.env mutations; output consumers must handle preview explicitly.",
      "No automatic rollback, checkpoint resume, or guarantee that arbitrary application actions are idempotent.",
    ],
    discovery: "iac-composer describe <topic> --json",
  },
  commands: {
    run: {
      usage: "iac-composer [run] <deployment.ts|deployment.js> [options]",
      required: ["deployment file with a default async deployment function"],
      options: runOptions,
      effects: {
        default: ["local artifact writes", "authored commands", "Azure provisioning", "application deployment"],
        dryRun: ["authored module execution", "custom compiler execution", "local artifact writes"],
      },
    },
    down: {
      usage: "iac-composer down <generated-project-directory> --environment <name> --force [options]",
      options: {
        "--environment": { aliases: ["-e"], type: "string", required: true },
        "--cwd": { aliases: ["-C"], type: "string", description: "Alternative to the positional generated project directory." },
        "--force": { type: "boolean", required: true },
        "--purge": { type: "boolean", default: false, description: "Permanently remove soft-deleted resources; obtain separate human confirmation." },
        "--report": runOptions["--report"],
        "--help": runOptions["--help"],
      },
      effects: ["destructive Azure resource deletion", "permanent deletion with --purge"],
      guards: ["explicit environment", "--force", "recognized iac-composer ownership metadata and non-empty infra.layers"],
    },
    describe: {
      usage: "iac-composer describe [overview|commands|provisioning|report] [--json]",
      effects: ["read-only; no authored code loaded"],
    },
  },
  provisioning: {
    methods: {
      provision: "Compile a layer, provision immediately, return Record<string, string> outputs; preview returns {}.",
      deploy: "Execute an application callback or Command; skipped during preview.",
      run: "Execute a named Command; skipped during preview.",
      env: "Apply process environment values in order; skipped during preview.",
      execute: "Execute a Command inside an action; skipped during preview.",
      capture: "Execute a Command and return stdout; preview returns an empty string.",
      inDirectory: "Create a child context preserving environment, component, preview, log and event observer.",
    },
    source: {
      oneOf: [
        { required: ["layer"], shape: { layer: { entrypoint: "string", outputDirectory: "string" } } },
        { required: ["entrypoint"], shape: { entrypoint: "string", outputDirectory: "optional string" } },
        { required: ["compiler", "artifactsDirectory"], shape: { compiler: { command: "string", args: "optional string[]", cwd: "optional string", env: "optional NodeJS.ProcessEnv" }, artifactsDirectory: "string", outputDirectory: "optional string" } },
      ],
      constraints: [
        "Do not combine layer with entrypoint, outputDirectory, compiler, or artifactsDirectory.",
        "Do not combine entrypoint with compiler or artifactsDirectory.",
        "Compiler and artifactsDirectory must be supplied together.",
      ],
    },
    options: {
      templateFile: { type: "string", default: "main.bicep" },
      parametersFile: { type: "string", default: "main.bicepparam" },
      deploymentName: { type: "string", default: "sanitized output directory basename" },
      subscription: { type: "string", default: "AZURE_SUBSCRIPTION_ID" },
      location: { type: "string", default: "AZURE_LOCATION" },
      scope: { enum: ["subscription", "resourceGroup"], description: "Bicep targetScope remains authoritative." },
      resourceGroup: { type: "string", description: "Passed to azd as AZURE_RESOURCE_GROUP." },
      parameters: { type: "object", values: ["string", "number", "boolean"], constraint: "Overrides require a .bicepparam parameter directly bound to readEnvironmentVariable()." },
      environmentValues: { type: "object", values: ["string", "undefined"] },
    },
    outputBicepSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["path", "contents"],
        properties: { path: { type: "string", minLength: 1 }, contents: { type: "string" } },
      },
    },
    artifactConstraints: [
      "Paths must be relative, unique after normalization, and inside the output directory; file/directory conflicts are rejected.",
      "The selected template and parameters files must be emitted before artifacts are installed.",
    ],
    ordering: "Author calls in business order. Output directly under .generated/<layer> creates a named azd layer depending on the preceding first-seen layer. Repeated layers preserve their original dependency.",
    example: 'await deployment.provision("core", { entrypoint: "./infra.ts", outputDirectory: ".generated/core" });',
  },
  report: {
    schemaVersion: "1.0",
    format: "One JSON object at --report <path>, initialized before authored code; overwritten with the final result on handled success or failure.",
    schema: executionReportSchema,
    semantics: {
      stepIds: "Run-local sequence shared by child contexts; not persistent resource identifiers.",
      artifacts: "Locations prepared for a provisioning call, not a cloud state snapshot; inspect step status for completion.",
      retrySafety: "Never assume automatic retry is safe for an imperative program.",
    },
    privacy: "No command arguments, environment values, outputs, source contents or raw provider errors are collected. Authored labels and paths are included: never put secrets in them.",
    limitations: "Unknown authored/provider failures use PROGRAM_FAILED; original details remain on stderr. A killed process may leave status=running. Report writes are not transactional with deployment.",
  },
} as const;

export type DiscoveryTopic = keyof typeof topics;

export function describe(topic: string): object | undefined {
  if (!Object.hasOwn(topics, topic)) return undefined;
  return { schemaVersion: "1.0", tool: "iac-composer", topic, ...topics[topic as DiscoveryTopic] };
}
