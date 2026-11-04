import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const repository = resolve(".");

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("the packed runtime implements discovery and SDK authoring without the optional planner package", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "iac standalone "));
  const installed = join(scratch, "runtime");
  const workspace = join(scratch, "consumer");
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  t.after(async () => {
    await client?.close();
    await transport?.close();
    await rm(scratch, { recursive: true, force: true });
  });
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", scratch], {
    cwd: repository, maxBuffer: 2 * 1024 * 1024,
  });
  const archives: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(archives) && archives.length === 1);
  const archive = object(archives[0]);
  assert.ok(typeof archive.filename === "string" && Array.isArray(archive.files));
  const paths = archive.files.map((file) => object(file).path);
  assert.ok(paths.includes("agent-setup/README.md"));
  assert.ok(paths.includes("dist/mcp/cli.js"));
  assert.ok(paths.includes(".github/skills/iac-composer/SKILL.md"));
  assert.ok(paths.every((path) => typeof path === "string" && !path.includes("azure-infrastructure")));
  await mkdir(installed);
  await mkdir(workspace);
  await execFileAsync("tar", ["-xzf", join(scratch, archive.filename), "--strip-components=1", "-C", installed]);
  await symlink(join(repository, "node_modules"), join(installed, "node_modules"), "dir");
  await assert.rejects(access(join(installed, "tools/azure-infrastructure")), { code: "ENOENT" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installed, "dist/mcp/cli.js"), "--workspace", workspace],
    cwd: tmpdir(), env: getDefaultEnvironment(), stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  client = new Client({ name: "standalone-runtime-test", version: "1.0" });
  await client.connect(transport);
  for (const topic of ["start", "authoring", "helpers", "provisioning", "commands"]) {
    const reply = await client.callTool({ name: "iac_composer_get_context", arguments: { topic } });
    assert.equal(object(reply.structuredContent).status, "ready");
    assert.doesNotMatch(JSON.stringify(reply.structuredContent), /azure-infrastructure-intent|resourcesFile|solutionFile/);
  }
  const helper = await client.callTool({
    name: "iac_composer_get_reference", arguments: { symbol: "ensureResourceGroup" },
  });
  assert.equal(object(helper.structuredContent).status, "ready");
  assert.match(JSON.stringify(helper.structuredContent), /function ensureResourceGroup/);
  await t.test("a resource-only plan is authored as typed SDK source and previewed through the runtime", async (integration) => {
    const libraries = ["core", "serialization", "bicep", "storage"];
    const sdkRoot = join(repository, "examples/chatbot/node_modules/@azure");
    try {
      for (const library of libraries) await access(join(sdkRoot, `provisioning-${library}`));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        integration.skip("Real provisioning SDKs are not installed; standalone MCP isolation was still verified.");
        return;
      }
      throw error;
    }
    await mkdir(join(workspace, "node_modules/@azure"), { recursive: true });
    for (const library of libraries) {
      await symlink(join(sdkRoot, `provisioning-${library}`), join(workspace, "node_modules/@azure", `provisioning-${library}`), "dir");
    }
    await symlink(installed, join(workspace, "node_modules/iac-composer"), "dir");
    await symlink(join(repository, "node_modules/@types"), join(workspace, "node_modules/@types"), "dir");
    await writeFile(join(workspace, "resource-plan.txt"), "A storage account with TLS 1.2, HTTPS only, no anonymous blobs or shared-key access. No application host or compute. Requirements supplied by another planner.\n");
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      type: "module", dependencies: {
        "iac-composer": "file:../runtime",
        "@azure/provisioning-core": "0.1.0", "@azure/provisioning-serialization": "0.1.0",
        "@azure/provisioning-bicep": "0.1.0", "@azure/provisioning-storage": "0.1.0",
      },
    }));
    await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, types: ["node"] },
      include: ["*.ts"],
    }));
    const sdk = await client!.callTool({
      name: "iac_composer_get_reference", arguments: { packageName: "@azure/provisioning-storage", symbol: "StorageAccount" },
    });
    assert.equal(object(sdk.structuredContent).status, "ready");
    assert.match(JSON.stringify(sdk.structuredContent), /constructor/);
    await writeFile(join(workspace, "infra.ts"), `
import { Stack, fn } from "@azure/provisioning-core";
import { serialize } from "@azure/provisioning-serialization";
import { StorageAccount } from "@azure/provisioning-storage";
import { renderBicepFiles, createBicepParameterFile, renderBicepParameterFile } from "@azure/provisioning-bicep";
const stack = new Stack("main", { targetScope: "resourceGroup" });
const location = stack.parameters.add("location", "string");
const storage = new StorageAccount(stack, {
  name: fn.concat("archive", fn.uniqueString(fn.resourceGroup().id)), location,
  kind: "StorageV2", sku: { name: "Standard_LRS" },
  properties: { minimumTlsVersion: "TLS1_2", AllowBlobPublicAccess: false, allowSharedKeyAccess: false, EnableHttpsTrafficOnly: true }
});
stack.outputs.add("STORAGE_ACCOUNT_NAME", "string", storage.name);
const [rendered] = renderBicepFiles(serialize([stack]));
if (!rendered) throw new Error("Missing rendered stack");
export const outputBicep = [
  { ...rendered, path: "main.bicep" },
  renderBicepParameterFile(createBicepParameterFile("main.bicepparam", {
    using: "./main.bicep", parameters: { location: fn.readEnvironmentVariable("AZURE_LOCATION") }
  }))
];`);
    await writeFile(join(workspace, "deploy.ts"), `
import { defineDeployment, ensureResourceGroup, requiredEnv } from "iac-composer";
export default defineDeployment(async (d) => {
  await d.deploy("ensure resource group", async () => {
    await ensureResourceGroup(d, { name: requiredEnv("AZURE_RESOURCE_GROUP"), location: requiredEnv("AZURE_LOCATION"), subscription: requiredEnv("AZURE_SUBSCRIPTION_ID") });
  });
  const outputs = await d.provision("archive storage", { entrypoint: "./infra.ts", outputDirectory: ".generated/storage" });
  await d.env("publish outputs", outputs);
});`);
    await execFileAsync(process.execPath, [
      join(repository, "node_modules/typescript/bin/tsc"), "-p", join(workspace, "tsconfig.json"), "--noEmit",
    ]);
    const bin = join(workspace, "bin");
    await mkdir(bin);
    for (const command of ["az", "azd"]) {
      await writeFile(join(bin, command), "#!/bin/sh\nprintf 'unexpected cloud execution\\n' >&2\nexit 99\n", { mode: 0o700 });
    }
    const reportPath = join(workspace, "preview.json");
    await execFileAsync(process.execPath, [
      join(installed, "dist/cli.js"), join(workspace, "deploy.ts"), "--dry-run", "--report", reportPath,
    ], { cwd: workspace, env: {
      ...getDefaultEnvironment(), PATH: bin, AZURE_LOCATION: "westus2",
      AZURE_RESOURCE_GROUP: "rg-isolation-test", AZURE_SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000000",
    } });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.status, "succeeded");
    assert.deepEqual(report.steps.map((step: { status: string }) => step.status), ["skipped", "previewed", "skipped"]);
    const bicep = await readFile(join(workspace, ".generated/storage/main.bicep"), "utf8");
    assert.match(bicep, /Microsoft\.Storage\/storageAccounts/);
    assert.match(bicep, /allowBlobPublicAccess: false/);
    assert.match(bicep, /supportsHttpsTrafficOnly: true/);
    assert.match(bicep, /allowSharedKeyAccess: false/);
    assert.doesNotMatch(bicep, /Microsoft\.Web|Microsoft\.Compute/);
    const userFiles = await readdir(workspace);
    assert.equal(userFiles.includes("requirements.json") || userFiles.includes("solution.json"), false);
  });
  await unlink(join(installed, ".github/skills/iac-composer/references/direct-authoring.md"));
  const missing = await client.callTool({ name: "iac_composer_get_context", arguments: { topic: "authoring" } });
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing.structuredContent), /CONTEXT_ASSET_UNAVAILABLE/);
  assert.equal(stderr, "");
});
