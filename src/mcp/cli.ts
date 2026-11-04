#!/usr/bin/env node

import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { IacComposerError } from "../diagnostics.js";
import { createWorkspacePaths } from "../workspace.js";
import { createIacComposerMcpServer } from "./server.js";

async function main(): Promise<void> {
  const { values, tokens } = parseArgs({
    options: { workspace: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  if (values.help) {
    console.error("Usage: iac-composer-mcp --workspace <consumer-repository>\nRead-only TypeScript provisioning-library authoring, helper and runtime discovery. No planner dependency or cloud execution.");
    return;
  }
  if (!values.workspace?.trim() || tokens.filter((token) => token.kind === "option" && token.name === "workspace").length !== 1) {
    throw new IacComposerError({
      code: "WORKSPACE_REQUIRED", category: "usage",
      message: "Specify exactly one --workspace directory.",
      repair: "Register iac-composer-mcp with the consumer repository's absolute path.",
    });
  }
  const workspace = await createWorkspacePaths(values.workspace);
  const handle = serveStdio(
    () => createIacComposerMcpServer({ workspaceRoot: workspace.root }),
    { onerror: () => console.error("[iac-composer-mcp] MCP_PROTOCOL_ERROR: check the client/server connection and protocol compatibility.") },
  );
  const close = () => {
    void handle.close().catch(() => {
      console.error("[iac-composer-mcp] MCP_CLOSE_FAILED: could not close the stdio connection cleanly.");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error: unknown) => {
  const details = error instanceof IacComposerError ? error.diagnostic : {
    code: "MCP_START_FAILED",
    message: "The iac-composer MCP server could not start.",
    repair: "Check --workspace, the pinned runtime package and server registration. Use --help for usage.",
  };
  console.error(`[iac-composer-mcp] ${JSON.stringify(details)}`);
  process.exitCode = 1;
});
