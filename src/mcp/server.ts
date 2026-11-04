import { readFile } from "node:fs/promises";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  getIacComposerContext,
  implementationContextDescription,
  implementationReferenceDescription,
  implementationRouting,
  implementationTopics,
} from "../authoring-context.js";
import { IacComposerError, type Diagnostic } from "../diagnostics.js";
import { getTypeScriptReference, referencePackagePattern } from "../sdk-reference.js";
import { createWorkspacePaths } from "../workspace.js";

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

const outputSchema = z.object({
  schemaVersion: z.literal("1.0"),
  status: z.enum(["ready", "failed"]),
  data: z.record(z.string(), z.unknown()),
  diagnostics: z.array(diagnosticSchema),
});
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export async function createIacComposerMcpServer(
  options: { workspaceRoot: string },
): Promise<McpServer> {
  const workspace = await createWorkspacePaths(options.workspaceRoot);
  const metadata: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || typeof metadata.version !== "string") {
    throw new Error("The iac-composer package version is missing.");
  }
  const server = new McpServer({ name: "iac-composer", version: metadata.version }, {
    instructions: [
      implementationRouting.useWhen,
      ...implementationRouting.precedence,
      implementationRouting.planning,
      ...implementationRouting.exclusions,
      implementationRouting.safety,
    ].join("\n"),
  });
  server.registerTool("iac_composer_get_context", {
    title: "Implement Azure infrastructure in TypeScript",
    description: implementationContextDescription,
    inputSchema: z.object({
      topic: z.enum(implementationTopics).default("start"),
      projectDirectory: z.string().trim().min(1).optional()
        .describe("SDK inventory only: Node project directory inside the workspace; default root."),
    }).strict(),
    outputSchema,
    annotations,
  }, async ({ topic, projectDirectory }) => {
    try {
      const context = await getIacComposerContext(topic, { workspaceRoot: workspace.root, projectDirectory });
      return result({
        schemaVersion: "1.0",
        status: "ready",
        data: { ...context.data, topic: context.topic, workspaceRoot: workspace.root },
        diagnostics: [],
      });
    } catch (error) {
      return failure(error, "implementation context");
    }
  });
  server.registerTool("iac_composer_get_reference", {
    title: "Provisioning SDK and runtime helper types",
    description: implementationReferenceDescription,
    inputSchema: z.object({
      packageName: z.string().regex(referencePackagePattern).default("iac-composer")
        .describe("iac-composer or an installed @azure/provisioning-* package."),
      symbol: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).optional()
        .describe("Resource class, props/interface or helper identifier. Omit for the declaration entrypoint."),
      file: z.string().trim().min(1).optional()
        .describe("Optional package-relative .d.ts/.d.mts/.d.cts file to narrow lookup."),
      line: z.number().int().min(1).optional()
        .describe("Optional 1-based start line for a file excerpt; requires file and no symbol."),
      projectDirectory: z.string().trim().min(1).default(".")
        .describe("Node project directory inside the workspace, for installed SDK resolution."),
    }).strict(),
    outputSchema,
    annotations,
  }, async (args) => {
    try {
      const reference = await getTypeScriptReference({ ...args, workspaceRoot: workspace.root });
      return result({ schemaVersion: "1.0", status: "ready", data: { ...reference }, diagnostics: [] });
    } catch (error) {
      return failure(error, "TypeScript reference");
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

function failure(error: unknown, stage: string): CallToolResult {
  const diagnostic: Diagnostic = error instanceof IacComposerError ? error.diagnostic : {
    code: "IMPLEMENTATION_CONTEXT_FAILED",
    category: "configuration",
    message: `Could not read the ${stage}.`,
    repair: "Check the workspace, installed package metadata and declaration/reference assets. No code was executed; raw file contents are not copied into errors.",
  };
  return result({ schemaVersion: "1.0", status: "failed", data: {}, diagnostics: [diagnostic] }, true);
}
