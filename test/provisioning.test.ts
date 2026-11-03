import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { copyProvisioningArtifacts } from "../src/index.js";

test("generated provisioning replaces stale artifacts and preserves owned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-"));
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

test("provisioning rejects legacy deploy-js ownership state", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-provision-legacy-"));
  const artifacts = join(root, "artifacts");
  const output = join(root, "infra");
  await mkdir(artifacts, { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(artifacts, "main.bicep"), "new");
  await writeFile(join(output, ".deploy-js-generated.json"), "[]\n");

  await assert.rejects(
    copyProvisioningArtifacts(artifacts, output),
    /Legacy deploy-js generated output/,
  );
  await assert.rejects(
    access(join(output, ".iac-composer-generated.json")),
    { code: "ENOENT" },
  );
});