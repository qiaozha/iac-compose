import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeployment } from "../src/index.js";

test("dry run renders provision artifacts without running deployment actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-dry-run-"));
  const entrypoint = join(root, "infra.ts");
  const outputDirectory = join(root, "generated");
  await writeFile(
    entrypoint,
    `export const outputBicep = [
      { path: "main.bicep", contents: "targetScope = 'subscription'\\n" },
      { path: "main.bicepparam", contents: "using './main.bicep'\\n" }
    ];\n`,
  );
  const messages: string[] = [];
  let deploymentRan = false;
  const deployment = createDeployment({
    dryRun: true,
    environment: "dev",
    projectDirectory: root,
    log: (message) => messages.push(message),
  });

  await deployment.env("prepare shared values", { EXAMPLE: "value" });
  await deployment.provision("chatbot resources", {
    entrypoint,
    outputDirectory,
    deploymentName: "dry-run-infra",
  });
  await deployment.deploy("function app", () => {
    deploymentRan = true;
  });
  await deployment.run("patch logic workflow", { command: "tsx", args: ["patch.ts"] });

  assert.equal(deploymentRan, false);
  assert.match(
    await readFile(join(outputDirectory, "main.bicep"), "utf8"),
    /targetScope = 'subscription'/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(outputDirectory, "azure.yaml"), "utf8")),
    {
      name: "dry-run-infra",
      infra: { provider: "bicep", path: ".", module: "main" },
    },
  );
  assert.deepEqual(messages, [
    "[deploy-js] DRY env: prepare shared values",
    "[deploy-js] DRY provision: chatbot resources",
    "[deploy-js] $ azd provision --environment dev --no-prompt",
    "[deploy-js] DRY deploy: function app",
    "[deploy-js] DRY command: patch logic workflow",
  ]);
  assert.equal(messages.some((message) => message.includes("env new")), false);
});