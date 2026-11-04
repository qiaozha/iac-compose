import { readFile } from "node:fs/promises";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { IacComposerError, type Diagnostic } from "iac-composer";
import { z } from "zod";
import {
  azureInfrastructureRouting,
  contextTopics,
  getAzureInfrastructureContext,
  infrastructureContextDescription,
  infrastructureGenerationDescription,
} from "../agent-context.js";
import {
  generateDeploymentCode,
  type DeploymentCodeGenerationProgress,
} from "../generator.js";
import { createGenerationWorkspace } from "../generation/workspace.js";

const diagnosticSchema = z.object({
  code: z.string(),
  category: z.enum(["usage", "configuration", "compilation", "artifact", "execution", "program"]),
  message: z.string(),
  target: z.string().optional(),
  property: z.string().optional(),
  expected: z.string().optional(),
  repair: z.string(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().optional(),
});

const generationChecks = z.object({
  contracts: z.enum(["passed", "failed", "not-run"]),
  typescript: z.literal("not-run"),
  bicep: z.literal("not-run"),
  azure: z.literal("not-run"),
});

export async function createAzureInfrastructureMcpServer(
  options: { workspaceRoot: string },
): Promise<McpServer> {
  const workspace = await createGenerationWorkspace(options.workspaceRoot);
  const metadata: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || typeof metadata.version !== "string") {
    throw new Error("The azure-infrastructure package version is missing.");
  }
  const server = new McpServer({
    name: "azure-infrastructure",
    version: metadata.version,
  }, {
    instructions: [
      azureInfrastructureRouting.useWhen,
      ...azureInfrastructureRouting.precedence,
      ...azureInfrastructureRouting.exclusions,
      azureInfrastructureRouting.safety,
    ].join("\n"),
  });
  let generating = false;

  server.registerTool("azure_infrastructure_get_context", {
    title: "Azure infrastructure workflow and capabilities",
    description: infrastructureContextDescription,
    inputSchema: z.object({
      topic: z.enum(contextTopics).default("start"),
      query: z.string().trim().min(1).max(200).optional()
        .describe("Search terms for architecture-catalog only; matching is offline metadata lookup, not architecture inference."),
      limit: z.number().int().min(1).max(10).optional()
        .describe("Maximum architecture-catalog matches; default 5. Only valid for architecture-catalog."),
    }).strict(),
    outputSchema: z.object({
      schemaVersion: z.literal("1.0"),
      status: z.enum(["ready", "failed"]),
      topic: z.string(),
      data: z.record(z.string(), z.unknown()),
      diagnostics: z.array(diagnosticSchema),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ topic, query, limit }) => {
    try {
      const context = await getAzureInfrastructureContext(topic, { query, limit });
      return result({
        ...context,
        status: "ready",
        data: { ...context.data, workspaceRoot: workspace.root },
        diagnostics: [],
      });
    } catch (error) {
      return result({
        schemaVersion: "1.0",
        status: "failed",
        topic,
        data: {},
        diagnostics: [diagnostic(error, "context")],
      }, true);
    }
  });

  server.registerTool("azure_infrastructure_generate", {
    title: "Generate local Azure infrastructure source",
    description: infrastructureGenerationDescription,
    inputSchema: z.object({
      resourcesFile: z.string().trim().min(1).max(4096)
        .describe("Workspace-relative resource-requirements JSON, schemaVersion 1.0. Not implementation-contract.json."),
      solutionFile: z.string().trim().min(1).max(4096)
        .describe("Workspace-relative solution JSON, schemaVersion 1.0."),
      outputDirectory: z.string().trim().min(1).max(4096)
        .describe("Dedicated workspace-relative generated-source directory, separate from inputs. Existing unowned files cannot be replaced."),
    }).strict(),
    outputSchema: z.object({
      schemaVersion: z.literal("1.0"),
      status: z.enum(["generated", "failed"]),
      stage: z.string(),
      outputDirectory: z.string(),
      components: z.array(z.string()),
      files: z.array(z.string()),
      checks: generationChecks,
      nextSteps: z.array(z.string()),
      diagnostics: z.array(diagnosticSchema),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    let stage: DeploymentCodeGenerationProgress["stage"] = "loadingInputs";
    const checks: z.infer<typeof generationChecks> = {
      contracts: "not-run", typescript: "not-run", bicep: "not-run", azure: "not-run",
    };
    if (generating) {
      return result({
        schemaVersion: "1.0",
        status: "failed",
        stage,
        outputDirectory: args.outputDirectory,
        components: [],
        files: [],
        checks,
        nextSteps: [],
        diagnostics: [{
          code: "GENERATION_BUSY",
          category: "configuration",
          message: "Another generation is already running on this server.",
          repair: "Wait for the current result before submitting another generation request.",
        }],
      }, true);
    }
    generating = true;
    try {
      const generated = await generateDeploymentCode({
        ...args,
        workspaceRoot: workspace.root,
        onProgress: (progress) => {
          stage = progress.stage;
          if (progress.stage === "validatingContracts") checks.contracts = "failed";
          if (progress.stage === "planningComponents") checks.contracts = "passed";
        },
      });
      return result({
        schemaVersion: "1.0",
        status: "generated",
        stage,
        outputDirectory: args.outputDirectory,
        ...generated,
        checks,
        nextSteps: [
          "Inspect generated source and run the generated package's typecheck with its pinned dependencies.",
          "Run appropriate Bicep checks and a trusted iac-composer --dry-run --report preview.",
          "Generation does not prove Azure deployability or authorize cloud changes.",
        ],
        diagnostics: [],
      });
    } catch (error) {
      return result({
        schemaVersion: "1.0",
        status: "failed",
        stage,
        outputDirectory: args.outputDirectory,
        components: [],
        files: [],
        checks,
        nextSteps: [],
        diagnostics: [diagnostic(error, stage)],
      }, true);
    } finally {
      generating = false;
    }
  });
  return server;
}

function result(structuredContent: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function diagnostic(error: unknown, stage: string): Diagnostic {
  if (error instanceof IacComposerError) return error.diagnostic;
  return {
    code: stage === "context" ? "CONTEXT_FAILED" : "GENERATION_FAILED",
    category: stage === "writingFiles" ? "artifact" : "configuration",
    message: `Azure infrastructure operation failed during ${stage}.`,
    repair: stage === "writingFiles"
      ? "Check output ownership and filesystem permissions before regenerating; writes are not fully transactional."
      : "Inspect the supplied plan against the resources, schema and contract-workflow context topics. Use the existing local generator CLI for detailed diagnostics; raw input errors are not copied into MCP results.",
  };
}
