import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { generateDeploymentCode } from "../src/generator.js";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/mcp/cli.js");
const requirements = {
  schemaVersion: "1.0",
  solution: { name: "discovery-test", enabledComponents: ["api"] },
  resources: [
    { id: "documents", kind: "object-storage", requiredBy: ["api"], produces: ["storageAccountName"] },
    {
      id: "apiCompute", kind: "container-host", requiredBy: ["api"], source: "app",
      containerPort: 8080, produces: ["backendBaseUrl"],
      configuration: { runtimeSettings: { STORAGE_ACCOUNT_NAME: "${output.storageAccountName}" } },
    },
  ],
};
const solution = { schemaVersion: "1.0", components: [{ id: "api", source: "app" }] };

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "azure-infrastructure-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "requirements.json"), JSON.stringify(requirements));
  await writeFile(join(root, "solution.json"), JSON.stringify(solution));
  await mkdir(join(root, "app"));
  await writeFile(join(root, "app/Dockerfile"), 'FROM node:24-alpine\nCOPY server.mjs .\nCMD ["node", "server.mjs"]\n');
  await writeFile(join(root, "app/server.mjs"), 'import { createServer } from "node:http"; createServer((_, res) => res.end("ok")).listen(8080);\n');
  await mkdir(join(root, "bin"));
  for (const name of ["az", "azd"]) {
    const file = join(root, "bin", name);
    await writeFile(file, "#!/bin/sh\nprintf 'unexpected external operation\\n' >&2\nprintf 'unexpected external operation\\n' >> \"$MCP_EXTERNAL_LOG\"\nexit 99\n");
    await chmod(file, 0o700);
  }
  return root;
}

class RecordedStdioTransport extends StdioClientTransport {
  readonly frames: string[] = [];

  override async send(message: Parameters<StdioClientTransport["send"]>[0]): Promise<void> {
    this.frames.push(JSON.stringify(message));
    await super.send(message);
  }
}

async function connect(t: TestContext, root: string, legacy = false, entrypoint = cli) {
  const transport = new RecordedStdioTransport({
    command: process.execPath,
    args: [entrypoint, "--workspace", root],
    cwd: tmpdir(),
    env: { ...getDefaultEnvironment(), PATH: join(root, "bin"), MCP_EXTERNAL_LOG: join(root, "external.log") },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client(
    { name: "discovery-test", version: "1.0.0" },
    { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
  );
  t.after(async () => {
    await client.close();
    await transport.close();
    await assert.rejects(readFile(join(root, "external.log")), { code: "ENOENT" });
    assert.equal(stderr, "", "Server must not log raw tool failures or corrupt the connection.");
  });
  await client.connect(transport);
  return { client, frames: transport.frames };
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function generate(client: Client, args: Record<string, string> = {}) {
  return client.callTool({
    name: "azure_infrastructure_generate",
    arguments: {
      resourcesFile: "requirements.json",
      solutionFile: "solution.json",
      outputDirectory: "deployment",
      ...args,
    },
  });
}

function errorCode(reply: { isError?: boolean; structuredContent?: unknown }): string {
  assert.equal(reply.isError, true);
  const data = object(reply.structuredContent);
  assert.equal(data.status, "failed");
  assert.ok(Array.isArray(data.diagnostics) && data.diagnostics.length > 0);
  const diagnostic = object(data.diagnostics[0]);
  assert.ok(typeof diagnostic.code === "string");
  assert.ok(typeof diagnostic.repair === "string");
  return diagnostic.code;
}

for (const legacy of [false, true]) {
  test(`real stdio supports ${legacy ? "legacy initialization" : "modern discovery"} and advertises only the two local tools`, async (t) => {
    const root = await fixture(t);
    const { client, frames } = await connect(t, root, legacy);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), [
      "azure_infrastructure_generate", "azure_infrastructure_get_context",
    ]);
    assert.match(tools.find(({ name }) => name.endsWith("get_context"))?.description ?? "", /optional azure-infrastructure/);
    assert.equal(tools.find(({ name }) => name.endsWith("get_context"))?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(({ name }) => name.endsWith("generate"))?.annotations?.destructiveHint, true);
    assert.equal(tools.find(({ name }) => name.endsWith("generate"))?.annotations?.openWorldHint, false);
    const context = await client.callTool({ name: "azure_infrastructure_get_context", arguments: {} });
    const data = object(context.structuredContent);
    assert.equal(data.status, "ready");
    assert.equal(object(data.data).workspaceRoot, root);
    assert.match(frames.join("\n"), legacy ? /"method":"initialize"/ : /"method":"server\/discover"/);
    if (!legacy) assert.doesNotMatch(frames.join("\n"), /"method":"initialize"/);
    const generated = await generate(client);
    const result = object(generated.structuredContent);
    assert.equal(result.status, "generated");
    assert.deepEqual(result.checks, { contracts: "passed", typescript: "not-run", bicep: "not-run", azure: "not-run" });
  });
}

test("MCP generation equals the existing generator and repeated generation preserves unrelated files", async (t) => {
  const root = await fixture(t);
  const { client } = await connect(t, root);
  const reply = object((await generate(client)).structuredContent);
  const expected = await generateDeploymentCode({
    resourcesFile: join(root, "requirements.json"),
    solutionFile: join(root, "solution.json"),
    outputDirectory: join(root, "comparison"),
  });
  assert.deepEqual(reply.components, expected.components);
  assert.deepEqual(reply.files, expected.files);
  for (const file of expected.files) {
    assert.equal(
      await readFile(join(root, "deployment", file), "utf8"),
      await readFile(join(root, "comparison", file), "utf8"),
      file,
    );
  }
  await writeFile(join(root, "deployment/customer.txt"), "preserve");
  assert.equal(object((await generate(client)).structuredContent).status, "generated");
  assert.equal(await readFile(join(root, "deployment/customer.txt"), "utf8"), "preserve");
});

test("path and ownership failures do not replace the previous generated layer", async (t) => {
  const root = await fixture(t);
  const { client } = await connect(t, root);
  await generate(client);
  const previous = await readFile(join(root, "deployment/deploy.ts"), "utf8");
  for (const [args, expected] of [
    [{ resourcesFile: "../outside.json" }, "WORKSPACE_PATH_INVALID"],
    [{ resourcesFile: "missing.json" }, "SOURCE_UNAVAILABLE"],
    [{ outputDirectory: "." }, "OUTPUT_DIRECTORY_INVALID"],
    [{ outputDirectory: ".." }, "WORKSPACE_PATH_INVALID"],
  ] as const) {
    assert.equal(errorCode(await generate(client, args)), expected);
    assert.equal(await readFile(join(root, "deployment/deploy.ts"), "utf8"), previous);
  }
  await mkdir(join(root, "unowned"));
  await writeFile(join(root, "unowned/deploy.ts"), "customer source");
  assert.equal(errorCode(await generate(client, { outputDirectory: "unowned" })), "OUTPUT_CONFLICT");
  assert.equal(await readFile(join(root, "unowned/deploy.ts"), "utf8"), "customer source");
  await mkdir(join(root, "inputs"));
  await writeFile(join(root, "inputs/requirements.json"), JSON.stringify(requirements));
  assert.equal(errorCode(await generate(client, { resourcesFile: "inputs/requirements.json", outputDirectory: "inputs" })), "INPUT_OUTPUT_OVERLAP");
});

test("symlinked plan, template and output paths cannot escape or redirect generation", async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "azure-infrastructure-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "requirements.json"), JSON.stringify(requirements));
  await writeFile(join(outside, "workflow.json"), "{}");
  await symlink(outside, join(root, "external"), "dir");
  const { client } = await connect(t, root);
  assert.equal(errorCode(await generate(client, { resourcesFile: "external/requirements.json" })), "WORKSPACE_PATH_INVALID");
  assert.equal(errorCode(await generate(client, { outputDirectory: "external/output" })), "OUTPUT_SYMLINK_REFUSED");
  await mkdir(join(root, "inside"));
  await symlink(join(root, "inside"), join(root, "output-link"), "dir");
  assert.equal(errorCode(await generate(client, { outputDirectory: "output-link" })), "OUTPUT_SYMLINK_REFUSED");
  await writeFile(join(root, "requirements.json"), JSON.stringify({
    ...requirements,
    resources: [{
      id: "workflow", kind: "workflow-host", requiredBy: ["api"], source: "external/workflow.json",
    }],
  }));
  assert.equal(errorCode(await generate(client)), "WORKSPACE_PATH_INVALID");
});

test("invalid plans return stage-aware failures without echoing raw input and can be repaired", async (t) => {
  const root = await fixture(t);
  const { client } = await connect(t, root);
  await writeFile(join(root, "requirements.json"), '{"private":"DO_NOT_EXPOSE"');
  const invalid = await generate(client);
  assert.equal(errorCode(invalid), "GENERATION_FAILED");
  assert.doesNotMatch(JSON.stringify(invalid), /DO_NOT_EXPOSE/);
  await writeFile(join(root, "requirements.json"), JSON.stringify({
    ...requirements,
    resources: [{ id: "unsupported", kind: "not-supported", requiredBy: ["api"] }],
  }));
  const unsupported = await generate(client);
  assert.equal(errorCode(unsupported), "GENERATION_FAILED");
  assert.equal(object(unsupported.structuredContent).stage, "validatingContracts");
  await writeFile(join(root, "requirements.json"), JSON.stringify(requirements));
  assert.equal(object((await generate(client)).structuredContent).status, "generated");
  await writeFile(join(root, "requirements.json"), JSON.stringify({
    ...requirements, resources: [requirements.resources[0]],
  }));
  assert.equal(errorCode(await generate(client)), "COMPONENT_CONTAINER_REQUIRED");
});

test("metadata lookup cannot read arbitrary files or invoke deployment source", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "deploy.ts"), "throw new Error('deployment source must never be imported');");
  const { client } = await connect(t, root);
  const wrongArguments = await client.callTool({
    name: "azure_infrastructure_get_context", arguments: { topic: "start", query: "not a catalog query" },
  });
  assert.equal(errorCode(wrongArguments), "CONTEXT_ARGUMENT_INVALID");
  const schema = await client.callTool({
    name: "azure_infrastructure_get_context", arguments: { topic: "schema" },
  });
  assert.equal(object(schema.structuredContent).status, "ready");
});

test("the stdio launcher requires an explicit workspace and help never starts a server", async () => {
  const help = await execFileAsync(process.execPath, [cli, "--help"]);
  assert.equal(help.stdout, "");
  assert.match(help.stderr, /--workspace/);
  await assert.rejects(execFileAsync(process.execPath, [cli]), /WORKSPACE_REQUIRED/);
  await assert.rejects(execFileAsync(process.execPath, [
    cli, "--workspace", dirname(cli), "--workspace", tmpdir(),
  ]), /WORKSPACE_AMBIGUOUS/);
  await assert.rejects(execFileAsync(process.execPath, [cli, "--workspace", dirname(cli), "--unknown"]), /MCP_START_FAILED/);
});
