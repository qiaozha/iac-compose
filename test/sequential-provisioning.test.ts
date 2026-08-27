import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { createDeployment } from "../src/index.js";

test("dry run generates layered Bicep in one azd project", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-compose-components-"));
  const outputRoot = resolve(root, ".generated");
  const messages: string[] = [];
  const deployment = createDeployment({
    dryRun: true,
    environment: "dev",
    log: (message) => messages.push(message),
  });
  await mkdir(resolve(outputRoot, ".azure/dev"), { recursive: true });
  await writeFile(resolve(outputRoot, ".azure/dev/config.json"), "{}\n");
  await writeFile(resolve(outputRoot, ".iac-compose-project.json"), "{}\n");
  for (const component of ["shared", "agent", "agent", "frontend"]) {
    const outputDirectory = resolve(outputRoot, component);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(resolve(outputDirectory, "azure.yaml"), "{}\n");
    await writeFile(resolve(outputDirectory, "stale.bicep"), "stale\n");
    await writeFile(
      resolve(outputDirectory, ".iac-compose-generated.json"),
      `${JSON.stringify(["stale.bicep"], null, 2)}\n`,
    );
    await mkdir(resolve(outputDirectory, ".azure/dev"), { recursive: true });
    await writeFile(resolve(outputDirectory, ".azure/dev/config.json"), "{}\n");
    await deployment.provision(`${component} infrastructure`, {
      layer: {
        entrypoint: resolve(
          `examples/chatbot/src/components/${component}/provisioning.ts`,
        ),
        outputDirectory,
      },
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
    await assert.rejects(access(resolve(outputDirectory, "azure.yaml")));
    await assert.rejects(access(resolve(outputDirectory, ".azure")));
    await assert.rejects(access(resolve(outputDirectory, "stale.bicep")));
    await assert.rejects(
      access(resolve(outputDirectory, ".iac-compose-generated.json")),
    );
  }
  await access(resolve(outputRoot, ".azure/dev/config.json"));
  const generatedFiles = [
    "agent/main.bicep",
    "agent/main.bicepparam",
    "frontend/main.bicep",
    "frontend/main.bicepparam",
    "shared/main.bicep",
    "shared/main.bicepparam",
  ];
  assert.deepEqual(
    JSON.parse(
      await readFile(resolve(outputRoot, ".iac-compose-generated.json"), "utf8"),
    ),
    generatedFiles,
  );
  assert.deepEqual(
    JSON.parse(await readFile(resolve(outputRoot, "azure.yaml"), "utf8")),
    {
      name: "dev-chatbot",
      metadata: { template: "iac-compose@1.0.0" },
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
  await assert.rejects(
    access(resolve(outputRoot, ".iac-compose-project.json")),
  );
  assert.deepEqual(
    messages.filter((message) => message.startsWith("[iac-compose] $ azd provision")),
    [
      "[iac-compose] $ azd provision shared --environment dev --no-prompt",
      "[iac-compose] $ azd provision agent --environment dev --no-prompt",
      "[iac-compose] $ azd provision agent --environment dev --no-prompt",
      "[iac-compose] $ azd provision frontend --environment dev --no-prompt",
    ],
  );

  const componentDeployment = createDeployment({
    dryRun: true,
    environment: "dev",
    log: () => {},
  });
  await componentDeployment.provision("frontend infrastructure", {
    layer: {
      entrypoint: resolve(
        "examples/chatbot/src/components/frontend/provisioning.ts",
      ),
      outputDirectory: resolve(outputRoot, "frontend"),
    },
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
  assert.deepEqual(
    JSON.parse(
      await readFile(resolve(outputRoot, ".iac-compose-generated.json"), "utf8"),
    ),
    generatedFiles,
  );
});