import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const toolRoot = resolve(".");
const runtimeRoot = resolve("../..");

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function pack(directory: string, destination: string): Promise<{ path: string; files: string[] }> {
  const { stdout } = await execFileAsync("npm", [
    "pack", "--json", "--pack-destination", destination,
  ], { cwd: directory, maxBuffer: 2 * 1024 * 1024 });
  const packages: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(packages) && packages.length === 1);
  const metadata = object(packages[0]);
  assert.ok(typeof metadata.filename === "string");
  assert.equal(basename(metadata.filename), metadata.filename);
  assert.ok(Array.isArray(metadata.files));
  const files = metadata.files.map((entry) => {
    const path = object(entry).path;
    assert.ok(typeof path === "string");
    return path;
  });
  return { path: join(destination, metadata.filename), files };
}

test("packed assets serve MCP context and generation outside the checkout with installed dependencies", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "iac-composer packed "));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runtimePackage = await pack(runtimeRoot, scratch);
  const toolPackage = await pack(toolRoot, scratch);
  for (const path of [
    ".github/skills/azure-infrastructure-intent/SKILL.md",
    ".github/skills/azure-infrastructure-intent/references/implementation-contract.schema.json",
    "docs/mcp.md",
    "dist/mcp/cli.js",
    "src/runtime/services/authorization.ts",
  ]) assert.ok(toolPackage.files.includes(path), path);
  assert.ok(runtimePackage.files.includes(".github/skills/iac-composer/references/direct-authoring.md"));

  const installedRuntime = join(scratch, "toolchain");
  const installedTool = join(installedRuntime, "tools/azure-infrastructure");
  for (const [archive, directory] of [
    [runtimePackage.path, installedRuntime], [toolPackage.path, installedTool],
  ]) {
    await mkdir(directory, { recursive: true });
    await execFileAsync("tar", ["-xzf", archive, "--strip-components=1", "-C", directory]);
  }
  // Borrow installed third-party dependencies, but resolve this toolchain from its packed artifacts.
  await symlink(join(runtimeRoot, "node_modules"), join(installedRuntime, "node_modules"), "dir");
  await mkdir(join(installedTool, "node_modules"));
  for (const dependency of ["@modelcontextprotocol", "zod", "yaml"]) {
    await symlink(join(toolRoot, "node_modules", dependency), join(installedTool, "node_modules", dependency), "dir");
  }
  await symlink(installedRuntime, join(installedTool, "node_modules/iac-composer"), "dir");

  const workspace = join(scratch, "consumer");
  await mkdir(workspace);
  await writeFile(join(workspace, "requirements.json"), JSON.stringify({
    schemaVersion: "1.0",
    solution: { name: "packed", enabledComponents: ["api"] },
    resources: [{
      id: "apiCompute", kind: "container-host", requiredBy: ["api"],
      source: "app", containerPort: 8080, produces: ["backendBaseUrl"],
    }],
  }));
  await writeFile(join(workspace, "solution.json"), JSON.stringify({
    schemaVersion: "1.0", components: [{ id: "api", source: "app" }],
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installedTool, "dist/mcp/cli.js"), "--workspace", workspace],
    cwd: tmpdir(),
    env: getDefaultEnvironment(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: "packed-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  for (const topic of ["start", "intent", "schema", "direct-authoring", "runtime-provisioning"]) {
    const reply = await client.callTool({ name: "azure_infrastructure_get_context", arguments: { topic } });
    assert.equal(object(reply.structuredContent).status, "ready", topic);
  }
  const generated = await client.callTool({
    name: "azure_infrastructure_generate",
    arguments: { resourcesFile: "requirements.json", solutionFile: "solution.json", outputDirectory: "deployment" },
  });
  assert.equal(object(generated.structuredContent).status, "generated");
  assert.match(await readFile(join(workspace, "deployment/deploy.ts"), "utf8"), /iac-composer/);

  await unlink(join(installedRuntime, ".github/skills/iac-composer/references/direct-authoring.md"));
  const missing = await client.callTool({
    name: "azure_infrastructure_get_context", arguments: { topic: "direct-authoring" },
  });
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing.structuredContent), /CONTEXT_ASSET_UNAVAILABLE/);
  assert.equal(stderr, "");
});
