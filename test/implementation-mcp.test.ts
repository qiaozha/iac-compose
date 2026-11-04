import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/mcp/cli.js");

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

class RecordedTransport extends StdioClientTransport {
  readonly frames: string[] = [];
  override async send(message: Parameters<StdioClientTransport["send"]>[0]): Promise<void> {
    this.frames.push(JSON.stringify(message));
    await super.send(message);
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "iac-implementation-mcp-"));
  const transport = new RecordedTransport({
    command: process.execPath, args: [cli, "--workspace", root], cwd: tmpdir(),
    env: getDefaultEnvironment(), stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  t.after(async () => {
    await transport.close();
    await rm(root, { recursive: true, force: true });
    assert.equal(stderr, "");
  });
  return { root, transport };
}

for (const legacy of [false, true]) {
  test(`standalone implementation MCP serves ${legacy ? "legacy" : "modern"} clients without an intent provider`, async (t) => {
    const { root, transport } = await fixture(t);
    const client = new Client({ name: "independent-implementation-test", version: "1.0" }, {
      versionNegotiation: { mode: legacy ? "legacy" : "auto" },
    });
    t.after(() => client.close());
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), [
      "iac_composer_get_context", "iac_composer_get_reference",
    ]);
    assert.ok(tools.every(({ annotations }) => annotations?.readOnlyHint === true && annotations.destructiveHint === false));
    assert.match(tools[0]?.description ?? "", /@azure\/provisioning/);
    const context = await client.callTool({ name: "iac_composer_get_context", arguments: {} });
    const start = object(context.structuredContent);
    assert.equal(start.status, "ready");
    assert.equal(object(start.data).workspaceRoot, root);
    assert.doesNotMatch(JSON.stringify(start), /azure-infrastructure|resourcesFile|solutionFile/);
    const helper = await client.callTool({
      name: "iac_composer_get_reference", arguments: { symbol: "ensureRoleAssignment" },
    });
    assert.equal(object(helper.structuredContent).status, "ready");
    assert.match(JSON.stringify(helper.structuredContent), /function ensureRoleAssignment/);
    assert.match(transport.frames.join("\n"), legacy ? /"method":"initialize"/ : /"method":"server\/discover"/);
    if (!legacy) assert.doesNotMatch(transport.frames.join("\n"), /"method":"initialize"/);
    assert.deepEqual(await readdir(root), [], "Discovery must not scaffold a planner contract or mutate the workspace.");
  });
}

test("SDK discovery and lookup never import deployment or SDK entrypoints", async (t) => {
  const { root, transport } = await fixture(t);
  await writeFile(join(root, "deployment.ts"), 'throw new Error("deployment must not be loaded");');
  const sdk = join(root, "node_modules/@azure/provisioning-demo");
  await mkdir(sdk, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@azure/provisioning-demo": "1.2.3" } }));
  await writeFile(join(sdk, "package.json"), JSON.stringify({
    name: "@azure/provisioning-demo", version: "1.2.3", main: "index.js", types: "index.d.ts",
  }));
  await writeFile(join(sdk, "index.js"), 'throw new Error("SDK entrypoint must not execute");');
  await writeFile(join(sdk, "index.d.ts"), "export declare class ExampleResource { constructor(name: string); }\n");
  const previous = await readFile(join(root, "package.json"), "utf8");
  const client = new Client({ name: "sdk-reference-test", version: "1.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const inventory = await client.callTool({ name: "iac_composer_get_context", arguments: { topic: "sdk" } });
  assert.match(JSON.stringify(inventory.structuredContent), /1\.2\.3/);
  const reference = await client.callTool({
    name: "iac_composer_get_reference", arguments: { packageName: "@azure/provisioning-demo", symbol: "ExampleResource" },
  });
  assert.equal(object(reference.structuredContent).status, "ready");
  assert.match(JSON.stringify(reference.structuredContent), /constructor\(name: string\)/);
  assert.equal(await readFile(join(root, "package.json"), "utf8"), previous);
  const missing = await client.callTool({
    name: "iac_composer_get_reference", arguments: { packageName: "@azure/provisioning-missing-test-fixture" },
  });
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing.structuredContent), /SDK_PACKAGE_UNAVAILABLE/);
  const invalid = await client.callTool({
    name: "iac_composer_get_context", arguments: { topic: "start", projectDirectory: ".." },
  });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid.structuredContent), /CONTEXT_ARGUMENT_INVALID/);
});

test("the runtime-owned launcher requires one explicit workspace and does not start on help", async () => {
  const help = await execFileAsync(process.execPath, [cli, "--help"]);
  assert.equal(help.stdout, "");
  assert.match(help.stderr, /iac-composer-mcp/);
  await assert.rejects(execFileAsync(process.execPath, [cli]), /WORKSPACE_REQUIRED/);
  await assert.rejects(execFileAsync(process.execPath, [
    cli, "--workspace", tmpdir(), "--workspace", tmpdir(),
  ]), /WORKSPACE_REQUIRED/);
});
