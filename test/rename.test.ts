import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  copyProvisioningArtifacts,
  createDeployment,
  getAzdProject,
  iacComposerAzdTemplate,
} from "../src/index.js";

test("package, CLI script, import resolution and skill use iac-composer", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.name, "iac-composer");
  assert.deepEqual(manifest.bin, {
    "iac-composer": "dist/cli.js",
    "iac-composer-mcp": "dist/mcp/cli.js",
  });
  assert.equal(manifest.scripts["iac-composer"], "tsx src/cli.ts");
  assert.equal(Object.hasOwn(manifest.scripts, "iac-compose"), false);
  assert.match(
    import.meta.resolve("iac-composer"),
    /\/(?:src\/index\.ts|dist\/index\.js)$/,
  );
  assert.match(
    await readFile(".github/skills/iac-composer/SKILL.md", "utf8"),
    /^---\nname: iac-composer\n/,
  );
  await assert.rejects(access(".github/skills/iac-compose"), { code: "ENOENT" });
});

test("renamed provisioning manifests merge ownership without deleting customer files", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-manifest-"));
  try {
    const artifacts = join(root, "artifacts");
    const output = join(root, "infra");
    await mkdir(artifacts);
    await mkdir(output);
    await writeFile(join(artifacts, "main.bicep"), "new");
    await writeFile(join(output, "old.bicep"), "old");
    await writeFile(join(output, "stale.bicep"), "stale");
    await writeFile(join(output, "customer.json"), "owned");
    await writeFile(
      join(output, ".iac-compose-generated.json"),
      JSON.stringify(["old.bicep"]),
    );
    await writeFile(
      join(output, ".iac-composer-generated.json"),
      JSON.stringify(["stale.bicep"]),
    );

    await copyProvisioningArtifacts(artifacts, output);

    assert.equal(await readFile(join(output, "customer.json"), "utf8"), "owned");
    assert.equal(await readFile(join(output, "main.bicep"), "utf8"), "new");
    for (const file of ["old.bicep", "stale.bicep", ".iac-compose-generated.json"]) {
      await assert.rejects(access(join(output, file)), { code: "ENOENT" });
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(output, ".iac-composer-generated.json"), "utf8")),
      ["main.bicep"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid previous ownership state fails before replacing artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-invalid-state-"));
  try {
    const artifacts = join(root, "artifacts");
    const output = join(root, "infra");
    await mkdir(artifacts);
    await mkdir(output);
    await writeFile(join(artifacts, "main.bicep"), "new");
    await writeFile(join(output, "main.bicep"), "existing");
    await writeFile(join(output, ".iac-compose-generated.json"), "{}");
    await assert.rejects(
      copyProvisioningArtifacts(artifacts, output),
      /Invalid generated-file manifest/,
    );
    assert.equal(await readFile(join(output, "main.bicep"), "utf8"), "existing");
    await access(join(output, ".iac-compose-generated.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default provisioning directory migration retains azd environment state", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-default-state-"));
  try {
    const previous = join(root, ".iac-compose", "infra");
    const current = join(root, ".iac-composer", "infra");
    await mkdir(join(previous, ".azure/dev"), { recursive: true });
    await writeFile(join(previous, ".azure/dev/config.json"), '{"existing":true}');
    await writeFile(join(previous, "customer.json"), "owned");
    await writeFile(join(previous, "stale.bicep"), "old");
    await writeFile(
      join(previous, ".iac-compose-generated.json"),
      JSON.stringify(["stale.bicep"]),
    );
    const entrypoint = join(root, "infra.ts");
    await writeFile(
      entrypoint,
      `export const outputBicep = [
        { path: "main.bicep", contents: "targetScope = 'resourceGroup'\\n" },
        { path: "main.bicepparam", contents: "using './main.bicep'\\n" },
      ];`,
    );

    await createDeployment({
      projectDirectory: root,
      environment: "dev",
      dryRun: true,
      log: () => {},
    }).provision("resources", { entrypoint });

    await assert.rejects(access(join(root, ".iac-compose")), { code: "ENOENT" });
    assert.equal(
      await readFile(join(current, ".azure/dev/config.json"), "utf8"),
      '{"existing":true}',
    );
    assert.equal(await readFile(join(current, "customer.json"), "utf8"), "owned");
    await access(join(current, ".iac-composer-generated.json"));
    await assert.rejects(access(join(current, "stale.bicep")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflicting default directories require an explicit outputDirectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-conflicting-state-"));
  try {
    await mkdir(join(root, ".iac-compose/infra"), { recursive: true });
    await mkdir(join(root, ".iac-composer/infra"), { recursive: true });
    await assert.rejects(
      createDeployment({ projectDirectory: root, dryRun: true, log: () => {} })
        .provision("resources", { entrypoint: join(root, "infra.ts") }),
      /Both .* exist.*Specify outputDirectory/,
    );
    await access(join(root, ".iac-compose/infra"));
    await access(join(root, ".iac-composer/infra"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("azd ownership migration preserves existing project name, layers and environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-azd-state-"));
  try {
    await mkdir(join(root, ".azure/dev"), { recursive: true });
    await writeFile(join(root, ".azure/dev/config.json"), '{"existing":true}');
    const layers = [{ name: "shared", path: "./shared", module: "main" }];
    await writeFile(
      join(root, "azure.yaml"),
      JSON.stringify({
        name: "existing-project",
        metadata: { template: "iac-compose@1.0.0", customer: "owned" },
        infra: { provider: "bicep", layers },
      }),
    );
    await getAzdProject(createDeployment({ dryRun: true, log: () => {} }), {
      directory: root,
      mergeManifest: true,
      manifest: {
        name: "new-name",
        services: { api: { host: "appservice" } },
      },
    }).initialize();
    const manifest = JSON.parse(await readFile(join(root, "azure.yaml"), "utf8"));
    assert.equal(manifest.name, "existing-project");
    assert.deepEqual(manifest.metadata, {
      template: iacComposerAzdTemplate,
      customer: "owned",
    });
    assert.deepEqual(manifest.infra.layers, layers);
    assert.equal(
      await readFile(join(root, ".azure/dev/config.json"), "utf8"),
      '{"existing":true}',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
