import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeployment, getAzdProject } from "../src/index.js";

test("dry-run azd preparation writes a manifest without environment state", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-azd-dry-"));
  const projectDirectory = join(root, "project");
  const deployment = createDeployment({
    dryRun: true,
    environment: "dev",
    projectDirectory: root,
    log: () => {},
  });
  const project = getAzdProject(deployment, {
    directory: projectDirectory,
    manifest: { name: "dry-project", services: {} },
  });

  await project.initialize();

  assert.deepEqual(
    JSON.parse(await readFile(join(projectDirectory, "azure.yaml"), "utf8")),
    { name: "dry-project", services: {} },
  );
  await assert.rejects(access(join(projectDirectory, ".azure")));
});

test("azd service preparation merges with component infrastructure", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-azd-merge-"));
  const projectDirectory = join(root, "component");
  const deployment = createDeployment({
    dryRun: true,
    environment: "dev",
    projectDirectory: root,
    log: () => {},
  });
  const infrastructureProject = getAzdProject(deployment, {
    directory: projectDirectory,
    manifest: {
      name: "dev-component",
      infra: { provider: "bicep", path: ".", module: "main" },
    },
  });
  await infrastructureProject.initialize();
  const serviceProject = getAzdProject(deployment, {
    directory: projectDirectory,
    mergeManifest: true,
    manifest: {
      name: "deploy-component",
      services: {
        api: { host: "appservice", language: "docker" },
      },
    },
  });
  assert.equal(serviceProject, infrastructureProject);
  await serviceProject.initialize();

  assert.deepEqual(
    JSON.parse(await readFile(join(projectDirectory, "azure.yaml"), "utf8")),
    {
      name: "dev-component",
      infra: { provider: "bicep", path: ".", module: "main" },
      services: {
        api: { host: "appservice", language: "docker" },
      },
    },
  );
});

test("azd helper generates an isolated project and imports lifecycle outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-azd-"));
  const bin = join(root, "bin");
  const projectDirectory = join(root, "project");
  const invocationLog = join(root, "azd.log");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const fakeAzd = join(bin, "azd");
  await writeFile(
    fakeAzd,
    `#!/bin/sh
printf '%s\n' "$*" >> "$DEPLOY_JS_AZD_LOG"
if [ "$1 $2" = "env new" ]; then
  mkdir -p ".azure/$3"
  printf '{}\n' > ".azure/$3/config.json"
fi
if [ "$1 $2 $3" = "env set --file" ]; then
  sed 's/^/env-value /' "$4" >> "$DEPLOY_JS_AZD_LOG"
fi
if [ "$1 $2" = "env get-values" ]; then
  printf '%s\n' 'SERVICE_NAME="deployed-service"' 'SERVICE_URI="https://example.test"'
fi
`,
  );
  await chmod(fakeAzd, 0o755);

  const previousPath = process.env.PATH;
  const previousLog = process.env.DEPLOY_JS_AZD_LOG;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.DEPLOY_JS_AZD_LOG = invocationLog;
  try {
    const deployment = createDeployment({
      environment: "dev",
      projectDirectory: root,
      log: () => {},
    });
    const project = getAzdProject(deployment, {
      directory: projectDirectory,
      manifest: {
        name: "helper-test",
        infra: { provider: "bicep", path: ".", module: "main" },
      },
      subscription: "00000000-0000-0000-0000-000000000000",
      location: "westus2",
      values: { RESOURCE_NAME: "api-dev" },
    });

    const provisioned = await project.provision();
    const serviceProject = getAzdProject(deployment, {
      directory: projectDirectory,
      mergeManifest: true,
      manifest: {
        name: "deploy-api",
        services: {
          api: { host: "appservice", language: "docker" },
        },
      },
    });
    assert.equal(serviceProject, project);
    const deployed = await serviceProject.deploy("api", {
      fromPackage: "registry.example/api:dev",
    });
    await serviceProject.setValues({ LIFECYCLE_OUTPUT: "persisted" });

    assert.equal(provisioned.SERVICE_NAME, "deployed-service");
    assert.equal(deployed.SERVICE_URI, "https://example.test");
    assert.equal(process.env.SERVICE_NAME, "deployed-service");
    assert.equal(process.env.LIFECYCLE_OUTPUT, "persisted");
    assert.deepEqual(
      JSON.parse(await readFile(join(projectDirectory, "azure.yaml"), "utf8")),
      {
        name: "helper-test",
        infra: { provider: "bicep", path: ".", module: "main" },
        services: {
          api: { host: "appservice", language: "docker" },
        },
      },
    );
    const invocations = (await readFile(invocationLog, "utf8")).trim().split("\n");
    assert.equal(invocations.filter((line) => line.startsWith("env new ")).length, 1);
    assert.equal(
      invocations.some(
        (line) => line === 'env-value RESOURCE_NAME="api-dev"',
      ),
      true,
    );
    assert.equal(
      invocations.some((line) => line.startsWith("provision --environment dev")),
      true,
    );
    assert.equal(
      invocations.some(
        (line) =>
          line.startsWith("deploy api --environment dev") &&
          line.includes("--from-package registry.example/api:dev"),
      ),
      true,
    );
    assert.equal(
      invocations.some(
        (line) => line === 'env-value LIFECYCLE_OUTPUT="persisted"',
      ),
      true,
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.DEPLOY_JS_AZD_LOG;
    else process.env.DEPLOY_JS_AZD_LOG = previousLog;
    delete process.env.LIFECYCLE_OUTPUT;
  }
});