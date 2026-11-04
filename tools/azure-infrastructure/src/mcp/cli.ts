#!/usr/bin/env node

import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { IacComposerError } from "iac-composer";
import { createGenerationWorkspace } from "../generation/workspace.js";
import { createAzureInfrastructureMcpServer } from "./server.js";

async function main(): Promise<void> {
  const { values, tokens } = parseArgs({
    options: {
      workspace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  if (values.help) {
    console.error("Usage: azure-infrastructure-mcp --workspace <consumer-repository>\nLocal stdio MCP: read-only discovery and local source generation; no Azure execution.");
    return;
  }
  if (tokens.filter((token) => token.kind === "option" && token.name === "workspace").length > 1) {
    throw new IacComposerError({
      code: "WORKSPACE_AMBIGUOUS",
      category: "usage",
      message: "--workspace must be specified exactly once.",
      repair: "Register one consumer repository per server configuration.",
    });
  }
  if (!values.workspace?.trim()) {
    throw new IacComposerError({
      code: "WORKSPACE_REQUIRED",
      category: "usage",
      message: "An explicit --workspace directory is required.",
      repair: "Register the server with the consumer repository's absolute path.",
    });
  }
  const workspace = await createGenerationWorkspace(values.workspace);
  const handle = serveStdio(
    () => createAzureInfrastructureMcpServer({ workspaceRoot: workspace.root }),
    { onerror: () => console.error("[azure-infrastructure-mcp] MCP_PROTOCOL_ERROR: check the client/server connection and protocol compatibility.") },
  );
  const close = () => {
    void handle.close().catch(() => {
      console.error("[azure-infrastructure-mcp] MCP_CLOSE_FAILED: could not close the stdio connection cleanly.");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error: unknown) => {
  const details = error instanceof IacComposerError
    ? error.diagnostic
    : {
        code: "MCP_START_FAILED",
        message: "The local MCP server could not start.",
        repair: "Check --workspace, the pinned package installation and server registration. Use --help for usage.",
      };
  console.error(`[azure-infrastructure-mcp] ${JSON.stringify(details)}`);
  process.exitCode = 1;
});
