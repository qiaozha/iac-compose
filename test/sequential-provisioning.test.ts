import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { createDeployment } from "../src/index.js";

test("dry run generates Bicep and azd manifests for multiple components", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "deploy-js-components-"));
  const deployment = createDeployment({
    dryRun: true,
    environment: "dev",
    log: () => {},
  });
  for (const component of ["shared", "agent", "frontend"]) {
    const outputDirectory = resolve(outputRoot, component);
    await deployment.provision(`${component} infrastructure`, {
      entrypoint: resolve(
        `examples/chatbot/src/components/${component}/provisioning.ts`,
      ),
      outputDirectory,
      deploymentName: `dev-${component}`,
      scope: "resourceGroup",
      resourceGroup: "rg-test",
      subscription: "00000000-0000-0000-0000-000000000000",
      location: "westus2",
    });
    assert.ok((await readFile(resolve(outputDirectory, "main.bicep"), "utf8")).trim());
    assert.ok(
      (await readFile(resolve(outputDirectory, "main.bicepparam"), "utf8")).trim(),
    );
    assert.equal(
      JSON.parse(await readFile(resolve(outputDirectory, "azure.yaml"), "utf8"))
        .name,
      `dev-${component}`,
    );
  }
});