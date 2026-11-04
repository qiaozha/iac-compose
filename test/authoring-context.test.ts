import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { IacComposerError } from "../src/diagnostics.js";
import { getIacComposerContext, implementationTopics } from "../src/authoring-context.js";
import { getTypeScriptReference } from "../src/sdk-reference.js";
import { describe } from "../src/discovery.js";

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iac-authoring-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, "node_modules/@azure/provisioning-storage");
  await mkdir(join(sdk, "models"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    dependencies: { "@azure/provisioning-storage": "9.8.7" },
  }));
  await writeFile(join(sdk, "package.json"), JSON.stringify({
    name: "@azure/provisioning-storage", version: "9.8.7", main: "index.js", types: "index.d.ts",
  }));
  await writeFile(join(sdk, "index.js"), 'throw new Error("SDK code must never execute during lookup");');
  await writeFile(join(sdk, "index.d.ts"), 'export { StorageAccount, StorageAccountProps } from "./models/storage.js";\n');
  await writeFile(join(sdk, "models/storage.d.ts"), [
    "export interface StorageAccountProps {",
    "  name: string;",
    "  location: string;",
    "}",
    "export declare class StorageAccount {",
    "  constructor(stack: unknown, props: StorageAccountProps);",
    "}",
    "",
  ].join("\n"));
  return root;
}

function code(expected: string) {
  return (error: unknown) => error instanceof IacComposerError && error.diagnostic.code === expected;
}

test("implementation context prefers typed resource authoring, not a particular planner or generator", async () => {
  const context = await getIacComposerContext();
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 8 * 1024);
  assert.match(JSON.stringify(context), /@azure\/provisioning/);
  assert.match(JSON.stringify(context), /any planning workflow/);
  assert.match(JSON.stringify(context), /deployment\.provision/);
  assert.doesNotMatch(JSON.stringify(context), /azure-infrastructure|resourcesFile|solutionFile|implementation-contract\.json/);
  assert.equal(Object.hasOwn(context.data, "generationInputs"), false);
});

test("all implementation topics work without a planning package and without network access", async (t) => {
  const root = await fixture(t);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Discovery must not fetch."); };
  t.after(() => { globalThis.fetch = original; });
  for (const topic of implementationTopics) {
    const context = await getIacComposerContext(topic, { workspaceRoot: root });
    assert.equal(context.topic, topic);
    assert.ok(Object.keys(context.data).length > 0);
  }
  const authoring = await getIacComposerContext("authoring");
  assert.match(String(authoring.data.contents), /new StorageAccount/);
  assert.match(String(authoring.data.contents), /defineDeployment/);
  const provisioning = await getIacComposerContext("provisioning");
  assert.deepEqual(provisioning.data.capabilities, describe("provisioning"));
});

test("SDK inventory distinguishes declarations from installed packages and reports missing dependencies", async (t) => {
  const root = await fixture(t);
  const inventory = await getIacComposerContext("sdk", { workspaceRoot: root });
  assert.deepEqual(inventory.data.packages, [{
    packageName: "@azure/provisioning-storage", installed: true, version: "9.8.7",
  }]);
  await writeFile(join(root, "package.json"), JSON.stringify({
    dependencies: { "@azure/provisioning-missing-test-fixture": "1.0.0" },
  }));
  const missing = await getIacComposerContext("sdk", { workspaceRoot: root });
  assert.match(JSON.stringify(missing.data.packages), /SDK_PACKAGE_UNAVAILABLE/);
  await rm(join(root, "package.json"));
  assert.equal((await getIacComposerContext("sdk", { workspaceRoot: root })).data.manifestStatus, "missing");
  await assert.rejects(getIacComposerContext("sdk"), code("WORKSPACE_REQUIRED"));
});

test("lookup returns actual installed SDK and runtime helper types without importing SDK code", async (t) => {
  const root = await fixture(t);
  const reference = await getTypeScriptReference({
    workspaceRoot: root, packageName: "@azure/provisioning-storage", symbol: "StorageAccount",
  });
  assert.equal(reference.version, "9.8.7");
  assert.match(reference.matches[0]!.excerpt, /constructor\(stack: unknown, props: StorageAccountProps\)/);
  assert.equal(reference.matches[0]!.file, "models/storage.d.ts");
  const props = await getTypeScriptReference({
    workspaceRoot: root, packageName: "@azure/provisioning-storage", symbol: "StorageAccountProps",
  });
  assert.match(props.matches[0]!.excerpt, /location: string/);
  const helper = await getTypeScriptReference({ workspaceRoot: root, symbol: "ensureRoleAssignment" });
  assert.equal(helper.packageName, "iac-composer");
  assert.match(helper.matches[0]!.excerpt, /function ensureRoleAssignment/);
  const page = await getTypeScriptReference({
    workspaceRoot: root, packageName: "@azure/provisioning-storage", file: "models/storage.d.ts", line: 5,
  });
  assert.equal(page.matches[0]!.line, 5);
  assert.match(page.matches[0]!.excerpt, /^export declare class StorageAccount/);
});

test("reference errors reject management SDKs, arbitrary files, missing symbols and symlink escapes", async (t) => {
  const root = await fixture(t);
  const base = { workspaceRoot: root, packageName: "@azure/provisioning-storage" };
  await assert.rejects(getTypeScriptReference({ ...base, packageName: "@azure/arm-storage" }), code("REFERENCE_PACKAGE_UNSUPPORTED"));
  await assert.rejects(getTypeScriptReference({ ...base, packageName: "@azure/provisioning-missing-test-fixture" }), code("SDK_PACKAGE_UNAVAILABLE"));
  await assert.rejects(getTypeScriptReference({ ...base, symbol: "DoesNotExist" }), code("REFERENCE_SYMBOL_NOT_FOUND"));
  await assert.rejects(getTypeScriptReference({ ...base, symbol: ".*" }), code("REFERENCE_SYMBOL_INVALID"));
  await assert.rejects(getTypeScriptReference({ ...base, file: "../../private.d.ts" }), code("REFERENCE_PATH_INVALID"));
  await assert.rejects(getTypeScriptReference({ ...base, file: "package.json" }), code("REFERENCE_PATH_INVALID"));
  await assert.rejects(getTypeScriptReference({ ...base, projectDirectory: ".." }), code("WORKSPACE_PATH_INVALID"));
  await assert.rejects(getTypeScriptReference({ ...base, line: 3 }), code("REFERENCE_ARGUMENT_INVALID"));
  await writeFile(join(root, "private.d.ts"), "declare const privateValue: string;");
  await symlink(join(root, "private.d.ts"), join(root, "node_modules/@azure/provisioning-storage/redirect.d.ts"));
  await assert.rejects(getTypeScriptReference({ ...base, file: "redirect.d.ts" }), code("REFERENCE_PATH_INVALID"));
  await assert.rejects(access(join(root, "sdk-executed")), { code: "ENOENT" });
});

test("unknown topics and irrelevant inventory arguments are not silently accepted", async () => {
  await assert.rejects(getIacComposerContext("toString"), code("CONTEXT_TOPIC_UNKNOWN"));
  await assert.rejects(getIacComposerContext("start", { projectDirectory: "other" }), code("CONTEXT_ARGUMENT_INVALID"));
});
