import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { copyProvisioningArtifacts } from "../src/index.js";

test("generated provisioning replaces stale artifacts and preserves owned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-"));
  const artifacts = join(root, "artifacts");
  const output = join(root, "infra");
  await mkdir(artifacts, { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(artifacts, "main.bicep"), "first");
  await writeFile(join(output, "environment.yaml"), "owned");

  await copyProvisioningArtifacts(artifacts, output);
  await writeFile(join(artifacts, "main.bicep"), "second");
  await copyProvisioningArtifacts(artifacts, output);

  assert.equal(await readFile(join(output, "main.bicep"), "utf8"), "second");
  assert.equal(await readFile(join(output, "environment.yaml"), "utf8"), "owned");
});