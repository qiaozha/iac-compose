import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

import {
  compileProvisioning,
  createDeployment,
  IacComposerError,
  requiredEnv,
  type DeploymentEvent,
  type ExecutionReport,
  type ProvisionOptions,
} from "../src/index.js";
import { executionReportSchema } from "../src/report.js";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/cli.js");
const validateReport = new Ajv2020.default({ strict: true }).compile(executionReportSchema);

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  return root;
}

async function invoke(root: string, args: string[], expectedExit = 0): Promise<ExecutionReport> {
  const reportPath = join(root, "report.json");
  try {
    await execFileAsync(process.execPath, [cli, ...args, "--report", reportPath]);
    assert.equal(expectedExit, 0, "CLI should have failed");
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, expectedExit);
  }
  const report: unknown = JSON.parse(await readFile(reportPath, "utf8"));
  assert.ok(validateReport(report), JSON.stringify(validateReport.errors));
  return report as ExecutionReport;
}

test("discovery is focused, structured and explicit about side effects and boundaries", async () => {
  const describe = async (topic: string) => JSON.parse((await execFileAsync(
    process.execPath, [cli, "describe", topic, "--json"],
  )).stdout);
  const overview = await describe("overview");
  assert.equal(overview.schemaVersion, "1.0");
  assert.equal(overview.resources.catalog, null);
  assert.equal(overview.resources.planningRequired, false);
  assert.match(overview.resources.planningInput, /any planning workflow/);
  assert.equal(overview.authoring.libraries, "@azure/provisioning-*");
  assert.ok(overview.limitations.some((value: string) => value.includes("custom compilers")));
  const commands = await describe("commands");
  assert.equal(commands.run.options["--dry-run"].default, false);
  assert.equal(commands.down.options["--force"].required, true);
  assert.equal(commands.down.options["--purge"].default, false);
  const provisioning = await describe("provisioning");
  assert.equal(provisioning.source.oneOf.length, 3);
  assert.equal(provisioning.outputBicepSchema.minItems, 1);
  assert.equal(provisioning.options.templateFile.default, "main.bicep");
  const report = await describe("report");
  assert.equal(report.schema.properties.retrySafety.const, "unknown");
  assert.equal(Object.hasOwn(overview, "schema"), false);
});

test("preview reports ordered steps, skipped actions, layer dependencies and artifact locations", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "infra.ts"), `export const outputBicep = [
    { path: "main.bicep", contents: "targetScope = 'resourceGroup'\\n" },
    { path: "main.bicepparam", contents: "using './main.bicep'\\n" }
  ];`);
  const program = join(root, "deploy.ts");
  await writeFile(join(root, "report.json"), "previous report", { mode: 0o644 });
  await writeFile(program, `
import { defineDeployment } from "iac-composer";
export default defineDeployment(async (d) => {
  await d.env("configuration", { SECRET_VALUE: "must-not-appear" });
  for (const layer of ["shared", "app"]) {
    await d.provision(layer, { entrypoint: "./infra.ts", outputDirectory: ".generated/" + layer });
  }
  await d.deploy("application", () => { throw new Error("must be skipped"); });
});`);
  const report = await invoke(root, [program, "-C", root, "--dry-run"]);
  assert.equal(report.status, "succeeded");
  assert.equal(report.dryRun, true);
  assert.equal(report.retrySafety, "unknown");
  assert.deepEqual(report.steps.map(({ id, name, status }) => ({ id, name, status })), [
    { id: 1, name: "configuration", status: "skipped" },
    { id: 2, name: "shared", status: "previewed" },
    { id: 3, name: "app", status: "previewed" },
    { id: 4, name: "application", status: "skipped" },
  ]);
  assert.deepEqual(report.artifacts.map(({ layer, dependsOn }) => ({ layer, dependsOn })), [
    { layer: "shared", dependsOn: [] },
    { layer: "app", dependsOn: ["shared"] },
  ]);
  for (const artifacts of report.artifacts) {
    await access(artifacts.templateFile);
    await access(artifacts.parametersFile);
    await access(artifacts.manifestFile);
  }
  assert.deepEqual(report.diagnostics, []);
  assert.doesNotMatch(JSON.stringify(report), /SECRET_VALUE|must-not-appear|targetScope/);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(root, "report.json"))).mode & 0o777, 0o600);
  }
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("missing flag values fail before importing a deployment or swallowing --dry-run", async (t) => {
  const root = await fixture(t);
  for (const option of ["--component", "--environment", "--cwd"]) {
    const report = await invoke(root, ["missing.ts", option, "--dry-run"], 1);
    assert.equal(report.diagnostics[0]?.code, "OPTION_VALUE_REQUIRED");
    assert.equal(report.diagnostics[0]?.property, option);
    assert.deepEqual(report.steps, []);
  }
  const cleanup = await invoke(root, ["down", root, "--environment", "--force"], 1);
  assert.equal(cleanup.diagnostics[0]?.code, "OPTION_VALUE_REQUIRED");
});

test("structured errors cover delegated commands, unknown topics, load and export failures", async (t) => {
  const root = await fixture(t);
  const noDefault = join(root, "empty.ts");
  await writeFile(noDefault, "export const unrelated = true;");
  const topLevelEnv = join(root, "env.ts");
  await writeFile(topLevelEnv, `import { requiredEnv } from "iac-composer";
requiredEnv("IAC_COMPOSER_UNSET", {});
export default async () => {};`);
  for (const [args, code] of [
    [["validate"], "COMMAND_DELEGATED"],
    [["describe", "toString"], "DISCOVERY_TOPIC_UNKNOWN"],
    [[join(root, "missing.ts"), "--dry-run"], "DEPLOYMENT_LOAD_FAILED"],
    [[noDefault, "--dry-run"], "DEPLOYMENT_EXPORT_INVALID"],
    [[topLevelEnv, "--dry-run"], "ENVIRONMENT_VALUE_REQUIRED"],
    [["--unknown"], "OPTION_UNKNOWN"],
    [["down", root, "-e", "dev"], "CLEANUP_CONFIRMATION_REQUIRED"],
    [["down", root, "-e", "dev", "--force"], "CLEANUP_PROJECT_UNVERIFIED"],
  ] as const) {
    const report = await invoke(root, [...args], 1);
    assert.equal(report.status, "failed");
    assert.equal(report.diagnostics[0]?.code, code);
    assert.ok(report.diagnostics[0]?.repair);
  }
});

test("reports preserve failed step and exit code without collecting command arguments or stderr", async (t) => {
  const root = await fixture(t);
  const program = join(root, "fail.ts");
  await writeFile(program, `
import { defineDeployment } from "iac-composer";
export default defineDeployment(async (d) => {
  await d.run("local failure", { command: process.execPath, args: ["-e", "console.error('sensitive-provider-detail'); process.exit(7)"] });
});`);
  const report = await invoke(root, [program], 1);
  assert.equal(report.steps[0]?.status, "failed");
  assert.equal(report.diagnostics[0]?.code, "COMMAND_FAILED");
  assert.equal(report.diagnostics[0]?.exitCode, 7);
  assert.equal(report.retrySafety, "unknown");
  assert.doesNotMatch(JSON.stringify(report), /sensitive-provider-detail|console.error/);
});

test("unknown authored errors are not copied into reports or success-shaped results", async (t) => {
  const root = await fixture(t);
  const program = join(root, "fail.ts");
  await writeFile(program, `export default async () => { throw new Error("private-value"); };`);
  const report = await invoke(root, [program, "--dry-run"], 1);
  assert.equal(report.diagnostics[0]?.code, "PROGRAM_FAILED");
  assert.doesNotMatch(JSON.stringify(report), /private-value/);
});

test("unwritable report destinations fail before authored code is loaded", async (t) => {
  const root = await fixture(t);
  const marker = join(root, "executed");
  const program = join(root, "deploy.ts");
  await writeFile(program, `
import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(marker)}, "unexpected");
export default async () => {};`);
  await assert.rejects(execFileAsync(process.execPath, [
    cli, program, "--report", join(root, "missing-parent/report.json"),
  ]), /ENOENT/);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("child contexts share event ordering without exposing environment values", async () => {
  const events: DeploymentEvent[] = [];
  const deployment = createDeployment({ dryRun: true, log: () => {}, onEvent: (event) => events.push(event) });
  await deployment.run("first", { command: "unused" });
  await deployment.inDirectory("child").env("second", { SECRET: "hidden" });
  await deployment.deploy("third", () => {});
  assert.deepEqual(events.filter((event) => event.type === "step").map(({ id }) => id), [1, 2, 3]);
  assert.doesNotMatch(JSON.stringify(events), /SECRET|hidden/);
});

test("requiredEnv provides actionable metadata without revealing configured values", () => {
  assert.throws(() => requiredEnv("TOKEN", { TOKEN: "REPLACE_WITH_secret" }), (error: unknown) => {
    assert.ok(error instanceof IacComposerError);
    assert.equal(error.diagnostic.code, "ENVIRONMENT_VALUE_REQUIRED");
    assert.equal(error.diagnostic.property, "TOKEN");
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /REPLACE_WITH_secret/);
    return true;
  });
});

test("ambiguous and partial sources fail before executing a custom compiler", async () => {
  for (const options of [
    { entrypoint: "infra.ts", compiler: { command: "must-not-run" }, artifactsDirectory: "files" },
    { compiler: { command: "must-not-run" } },
    { artifactsDirectory: "files" },
    { layer: { entrypoint: "infra.ts", outputDirectory: "files" }, entrypoint: "other.ts" },
  ] satisfies ProvisionOptions[]) {
    await assert.rejects(createDeployment({ dryRun: true, log: () => {} }).provision("invalid", options), (error: unknown) => {
      assert.ok(error instanceof IacComposerError);
      assert.equal(error.diagnostic.code, "PROVISION_SOURCE_INVALID");
      return true;
    });
  }
});

test("artifact preflight preserves previous files on invalid outputs and allows repair", async (t) => {
  const root = await fixture(t);
  const output = join(root, ".generated/app");
  const infra = join(root, "infra.ts");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "main.bicep"), "previous-template");
  await writeFile(join(root, ".generated/.iac-composer-generated.json"), '["app/main.bicep"]\n');
  const deployment = createDeployment({ dryRun: true, log: () => {} });
  const cases = [
    [["main.bicep"], "ARTIFACT_REQUIRED"],
    [["../escape.bicep", "main.bicep", "main.bicepparam"], "ARTIFACT_PATH_INVALID"],
    [["main.bicep", "./main.bicep", "main.bicepparam"], "ARTIFACT_PATH_DUPLICATE"],
    [["main.bicep", "main.bicepparam", "nested", "nested/file.bicep"], "ARTIFACT_PATH_CONFLICT"],
    [["", "main.bicep", "main.bicepparam"], "ARTIFACT_PATH_INVALID"],
  ] as const;
  for (const [index, [paths, code]] of cases.entries()) {
    await writeFile(infra, `export const outputBicep = ${JSON.stringify(paths.map((path) => ({ path, contents: "new" })))};`);
    // Unique module URLs avoid the standard ESM cache when re-authoring within one process.
    const entrypoint = join(root, `invalid-${index}.ts`);
    await writeFile(entrypoint, await readFile(infra, "utf8"));
    await assert.rejects(deployment.provision("app", { entrypoint, outputDirectory: output }), (error: unknown) => {
      assert.ok(error instanceof IacComposerError);
      assert.equal(error.diagnostic.code, code);
      return true;
    });
    assert.equal(await readFile(join(output, "main.bicep"), "utf8"), "previous-template");
    assert.equal(await readFile(join(root, ".generated/.iac-composer-generated.json"), "utf8"), '["app/main.bicep"]\n');
  }
  const repaired = join(root, "repaired.ts");
  await writeFile(repaired, `export const outputBicep = [
    { path: "main.bicep", contents: "targetScope = 'resourceGroup'\\n" },
    { path: "main.bicepparam", contents: "using './main.bicep'\\n" }
  ];`);
  await deployment.provision("app", { entrypoint: repaired, outputDirectory: output });
  assert.match(await readFile(join(output, "main.bicep"), "utf8"), /targetScope/);
  assert.deepEqual(await deployment.provision("app", { entrypoint: repaired, outputDirectory: output }), {});
});

test("standalone compilation preserves its optional-parameter-file behavior", async (t) => {
  const root = await fixture(t);
  const infra = join(root, "infra.ts");
  await writeFile(infra, 'export const outputBicep = [{ path: "..notes.bicep", contents: "valid relative name" }];');
  await compileProvisioning(infra, join(root, "compiled"));
  assert.equal(await readFile(join(root, "compiled/..notes.bicep"), "utf8"), "valid relative name");
});
