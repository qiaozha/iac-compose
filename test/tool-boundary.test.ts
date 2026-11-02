import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import * as runtime from "../src/index.js";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/cli.js");

test("exports execution primitives without planning or source generation", () => {
  assert.equal(typeof runtime.defineDeployment, "function");
  assert.equal(typeof runtime.createDeployment, "function");
  assert.equal(typeof runtime.ensureDeploymentPrincipalRoles, "function");
  for (const name of [
    "generateDeploymentCode",
    "loadResourceRequirements",
    "renderResourceRequirements",
    "fetchAzureArchitectureCatalog",
    "planResourceValidation",
    "validateResourceRequirements",
    "deployResourceComponent",
    "prepareResourceRequirements",
    "resolveOutputBindings",
    "createHostedAgentManifest",
    "deployHostedAgentService",
    "enableWorkflowDeployment",
    "parseHostedAgentVersion",
    "prepareAuthorizedConnection",
    "provisionTeamsApplication",
    "teamsEnvironmentName",
    "validateWorkflowParameters",
  ]) {
    assert.equal(Object.hasOwn(runtime, name), false, name);
  }
});

test("runtime source and declarations contain no resource contracts or contract adapters", async () => {
  for (const directory of ["src", "dist"]) {
    const entries = await readdir(directory, { recursive: true });
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      const source = await readFile(resolve(directory, entry), "utf8");
      assert.doesNotMatch(
        source,
        /ResourceContract|DeployResourceComponentOptions|deployResourceComponent|prepareResourceRequirements|resolveOutputBindings|shared\/contracts|runtime\/resources|deployHostedAgentService|provisionTeamsApplication|enableWorkflowDeployment/,
        entry,
      );
    }
  }
});

test("runtime CLI exposes execution and directs retired commands to the separate tool", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "--help"]);
  assert.match(stdout, /iac-composer <deployment.ts>/);
  assert.match(stdout, /iac-composer down/);
  assert.doesNotMatch(stdout, /iac-composer (generate|validate|architecture-catalog)/);
  for (const command of ["generate", "validate", "architecture-catalog"]) {
    await assert.rejects(
      execFileAsync(process.execPath, [cli, command]),
      new RegExp(`'${command}' belongs to the separate azure-infrastructure tool`),
    );
  }
});
