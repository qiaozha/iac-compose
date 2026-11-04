import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";

const setup = resolve("agent-setup");

test("host profiles use their own configuration formats without global writes or auto-approval", async () => {
  const portable = JSON.parse(await readFile(resolve(setup, "profiles/portable-mcp.json"), "utf8"));
  const vscode = JSON.parse(await readFile(resolve(setup, "profiles/vscode-mcp.json"), "utf8"));
  const codex = parse(await readFile(resolve(setup, "profiles/codex-config.toml"), "utf8"));
  assert.deepEqual(Object.keys(portable), ["mcpServers"]);
  assert.deepEqual(Object.keys(vscode), ["servers"]);
  for (const entry of [
    portable.mcpServers["iac-composer"],
    vscode.servers["iac-composer"],
  ]) {
    assert.equal(entry.command, "node");
    assert.equal(entry.args[1], "--workspace");
    assert.equal(entry.args.some((arg: string) => arg.includes("@latest")), false);
    assert.equal(Object.hasOwn(entry, "autoApprove"), false);
  }
  assert.equal(vscode.servers["iac-composer"].type, "stdio");
  const servers = codex.mcp_servers;
  assert.ok(typeof servers === "object" && servers !== null && !Array.isArray(servers) && !(servers instanceof Date));
  const entry = servers["iac-composer"];
  assert.ok(typeof entry === "object" && entry !== null && !Array.isArray(entry) && !(entry instanceof Date));
  assert.equal(entry.command, "node");
  assert.deepEqual(entry.enabled_tools, ["iac_composer_get_context", "iac_composer_get_reference"]);
  assert.equal(Object.hasOwn(entry, "default_tools_approval_mode"), false);
});

test("the routing block is conditional, shared and not automatically installed in the producer", async () => {
  const [policy, bridge, instructions] = await Promise.all([
    readFile(resolve(setup, "AGENTS.md.template"), "utf8"),
    readFile(resolve(setup, "CLAUDE.md.template"), "utf8"),
    readFile(resolve(setup, "README.md"), "utf8"),
  ]);
  assert.match(policy, /existing[\s\S]*Terraform, Bicep, azd/);
  assert.match(policy, /Advice-only and plan-only/);
  assert.match(policy, /Use one route/);
  assert.match(policy, /\.agents\/skills\/iac-composer\/SKILL\.md/);
  assert.match(policy, /any planner or the user/);
  assert.doesNotMatch(policy, /azure-infrastructure-intent|azure_infrastructure_generate/);
  assert.equal(bridge.trim(), "@AGENTS.md");
  assert.match(instructions, /Do not replace an existing instruction file/);
  assert.match(instructions, /Copilot CLI does \*\*not\*\* read/);
  assert.doesNotMatch(instructions, /gh skill install qiaozha\/iac-compose\s/);
  assert.doesNotMatch(instructions, /--scope user|--dangerously/);
});

test("selection fixtures include positive, precedence and unrelated cases without fabricated results", async () => {
  const matrix = JSON.parse(await readFile(resolve(setup, "evaluation/cases.json"), "utf8"));
  assert.equal(matrix.schemaVersion, "1.0");
  assert.equal(new Set(matrix.cases.map((entry: { id: string }) => entry.id)).size, matrix.cases.length);
  for (const id of ["generic-api", "complete-plan", "plan-only", "explicit-terraform", "existing-azd", "non-azure", "ordinary-code"]) {
    assert.ok(matrix.cases.some((entry: { id: string }) => entry.id === id));
  }
  for (const entry of matrix.cases) {
    assert.doesNotMatch(entry.prompt, /iac-composer|azure-infrastructure|get_context/);
  }
  const recorded = JSON.parse(await readFile(resolve(setup, "evaluation/result.template.json"), "utf8"));
  assert.equal(recorded.status, "not-executed");
  assert.equal(recorded.availability, null);
  assert.equal(recorded.agentToolCallsBeforeSelection, null);
  assert.deepEqual(recorded.evidence, []);
});
