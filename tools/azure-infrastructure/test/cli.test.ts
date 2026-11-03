import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import * as infrastructure from "../src/index.js";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/cli.js");

test("standalone tool owns generation, catalog, and resource-plan validation", async () => {
  for (const name of [
    "generateDeploymentCode",
    "renderResourceRequirements",
    "fetchAzureArchitectureCatalog",
    "planResourceValidation",
    "validateResourceRequirements",
    "deployResourceComponent",
    "prepareResourceRequirements",
    "resolveOutputBindings",
    "validateResourceContract",
  ] as const) {
    assert.equal(typeof infrastructure[name], "function", name);
  }
  const { stdout } = await execFileAsync(process.execPath, [cli, "--help"]);
  for (const command of ["generate", "validate", "architecture-catalog"]) {
    assert.ok(stdout.includes(`azure-infrastructure ${command}`));
  }
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "run"]),
    /Expected generate, validate, or architecture-catalog/,
  );
});
