import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { createDeployment } from "../src/index.js";

test("dry run generates layered Bicep in one azd project", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-components-"));
  const outputRoot = resolve(root, ".generated");
  const messages: string[] = [];
  const deployment = createDeployment({
    dryRun: true,
    environment: "dev",
    log: (message) => messages.push(message),
  });
  for (const component of ["shared", "agent", "agent", "frontend"]) {
    const outputDirectory = resolve(outputRoot, component);
    await deployment.provision(`${component} infrastructure`, {
      entrypoint: resolve(
        `examples/chatbot/src/components/${component}/provisioning.ts`,
      ),
      outputDirectory,
      deploymentName: "dev-chatbot",
      scope: "resourceGroup",
      resourceGroup: "rg-test",
      subscription: "00000000-0000-0000-0000-000000000000",
      location: "westus2",
    });
    assert.ok((await readFile(resolve(outputDirectory, "main.bicep"), "utf8")).trim());
    assert.ok(
      (await readFile(resolve(outputDirectory, "main.bicepparam"), "utf8")).trim(),
    );
  }
  assert.deepEqual(
    JSON.parse(await readFile(resolve(outputRoot, "azure.yaml"), "utf8")),
    {
      name: "dev-chatbot",
      requiredVersions: { azd: ">= 1.30.0" },
      infra: {
        provider: "bicep",
        layers: [
          { name: "shared", path: "./shared", module: "main" },
          {
            name: "agent",
            path: "./agent",
            module: "main",
            dependsOn: ["shared"],
          },
          {
            name: "frontend",
            path: "./frontend",
            module: "main",
            dependsOn: ["agent"],
          },
        ],
      },
    },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(resolve(outputRoot, ".deploy-js-project.json"), "utf8"),
    ),
    { schemaVersion: "1.0", kind: "layered-azd-project" },
  );
  assert.deepEqual(
    messages.filter((message) => message.startsWith("[deploy-js] $ azd provision")),
    [
      "[deploy-js] $ azd provision shared --environment dev --no-prompt",
      "[deploy-js] $ azd provision agent --environment dev --no-prompt",
      "[deploy-js] $ azd provision agent --environment dev --no-prompt",
      "[deploy-js] $ azd provision frontend --environment dev --no-prompt",
    ],
  );

  const componentDeployment = createDeployment({
    dryRun: true,
    environment: "dev",
    log: () => {},
  });
  await componentDeployment.provision("frontend infrastructure", {
    entrypoint: resolve(
      "examples/chatbot/src/components/frontend/provisioning.ts",
    ),
    outputDirectory: resolve(outputRoot, "frontend"),
    deploymentName: "dev-chatbot",
    scope: "resourceGroup",
    resourceGroup: "rg-test",
    subscription: "00000000-0000-0000-0000-000000000000",
    location: "westus2",
  });
  const rerunManifest = JSON.parse(
    await readFile(resolve(outputRoot, "azure.yaml"), "utf8"),
  ) as { infra: { layers: Array<{ name: string; dependsOn?: string[] }> } };
  assert.deepEqual(
    rerunManifest.infra.layers.find(({ name }) => name === "frontend")?.dependsOn,
    ["agent"],
  );
});