import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeployment } from "../src/index.js";

test("provision compiles JavaScript infrastructure and delegates deployment to azd", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-compose-provision-"));
  const bin = join(root, "bin");
  const invocation = join(root, "invocation.txt");
  const entrypoint = join(root, "infra.ts");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  await writeFile(
    entrypoint,
    `export const outputBicep = [
      { path: "main.bicep", contents: "targetScope = 'subscription'\\n" },
      { path: "main.bicepparam", contents: "using './main.bicep'\\nparam featureFlag = readEnvironmentVariable('FEATURE_FLAG')\\n" }
    ];\n`,
  );
  const fakeAzd = join(bin, "azd");
  await writeFile(
    fakeAzd,
    `#!/bin/sh
printf '%s\n' "$*" >> "$IAC_COMPOSE_INVOCATION"
if [ "$1 $2" = "env new" ]; then
  mkdir -p ".azure/$3"
  printf '{}\n' > ".azure/$3/config.json"
fi
if [ "$1 $2 $3" = "env set --file" ]; then
  sed 's/^/env-value /' "$4" >> "$IAC_COMPOSE_INVOCATION"
fi
if [ "$1 $2" = "env get-values" ]; then
  printf '%s\n' 'AZURE_RESOURCE_GROUP="rg-test"'
fi
`,
  );
  await chmod(fakeAzd, 0o755);

  const previousPath = process.env.PATH;
  const previousInvocation = process.env.IAC_COMPOSE_INVOCATION;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.IAC_COMPOSE_INVOCATION = invocation;
  try {
    const deployment = createDeployment({
      projectDirectory: root,
      environment: "test",
      log: () => {},
    });
    const outputs = await deployment.provision("test infrastructure", {
      entrypoint,
      outputDirectory: join(root, "generated"),
      deploymentName: "test-deployment",
      location: "westus2",
      subscription: "00000000-0000-0000-0000-000000000000",
      parameters: { featureFlag: true },
    });

    assert.deepEqual(outputs, { AZURE_RESOURCE_GROUP: "rg-test" });
    const invocations = (await readFile(invocation, "utf8")).trim().split("\n");
    assert.equal(
      invocations.some((line) => line.startsWith("provision --environment test")),
      true,
    );
    assert.equal(invocations.some((line) => line.startsWith("deployment ")), false);
    assert.equal(
      invocations.some((line) => line === 'env-value FEATURE_FLAG="true"'),
      true,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "generated", "azure.yaml"), "utf8")),
      {
        name: "test-deployment",
        infra: { provider: "bicep", path: ".", module: "main" },
      },
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousInvocation === undefined) delete process.env.IAC_COMPOSE_INVOCATION;
    else process.env.IAC_COMPOSE_INVOCATION = previousInvocation;
  }
});

test("a component can own a resource-group-scoped provision step", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-compose-component-"));
  const bin = join(root, "bin");
  const invocation = join(root, "invocation.txt");
  const entrypoint = join(root, "component.ts");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  await writeFile(
    entrypoint,
    `export const outputBicep = [
      { path: "main.bicep", contents: "targetScope = 'resourceGroup'\\n" },
      { path: "main.bicepparam", contents: "using './main.bicep'\\nparam resourceGroupName = readEnvironmentVariable('AZURE_RESOURCE_GROUP')\\n" }
    ];\n`,
  );
  const fakeAzd = join(bin, "azd");
  await writeFile(
    fakeAzd,
    `#!/bin/sh
printf '%s\n' "$*" >> "$IAC_COMPOSE_INVOCATION"
if [ "$1 $2" = "env new" ]; then
  mkdir -p ".azure/$3"
  printf '{}\n' > ".azure/$3/config.json"
fi
if [ "$1 $2 $3" = "env set --file" ]; then
  sed 's/^/env-value /' "$4" >> "$IAC_COMPOSE_INVOCATION"
fi
`,
  );
  await chmod(fakeAzd, 0o755);

  const previousPath = process.env.PATH;
  const previousInvocation = process.env.IAC_COMPOSE_INVOCATION;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.IAC_COMPOSE_INVOCATION = invocation;
  try {
    const deployment = createDeployment({ projectDirectory: root, log: () => {} });
    await deployment.provision("component resources", {
      entrypoint,
      outputDirectory: join(root, "generated"),
      scope: "resourceGroup",
      resourceGroup: "rg-component",
    });

    const invocations = (await readFile(invocation, "utf8")).trim().split("\n");
    assert.equal(
      invocations.some(
        (line) =>
          line === 'env-value AZURE_RESOURCE_GROUP="rg-component"',
      ),
      true,
    );
    assert.equal(
      invocations.some((line) => line.startsWith("provision --environment dev")),
      true,
    );
    assert.match(
      await readFile(join(root, "generated", "main.bicep"), "utf8"),
      /targetScope = 'resourceGroup'/,
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousInvocation === undefined) delete process.env.IAC_COMPOSE_INVOCATION;
    else process.env.IAC_COMPOSE_INVOCATION = previousInvocation;
  }
});