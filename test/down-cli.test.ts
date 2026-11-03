import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";

import { iacComposerAzdTemplate } from "../src/index.js";

const execFileAsync = promisify(execFile);

for (const template of [iacComposerAzdTemplate, "iac-compose@1.0.0"]) {
  test(`down requires confirmation for ownership '${template}'`, async () => {
    const root = await mkdtemp(join(tmpdir(), "iac-composer-down-"));
    const projectDirectory = join(root, ".generated");
    const bin = join(root, "bin");
    const log = join(root, "azd.log");
    await mkdir(projectDirectory);
    await mkdir(bin);
    await writeFile(
      join(projectDirectory, "azure.yaml"),
      JSON.stringify({
        name: "iac-composer-test",
        metadata: { template },
        infra: {
          provider: "bicep",
          layers: [{ name: "shared", path: "./shared" }],
        },
      }),
    );
    const fakeAzd = join(bin, "azd");
    await writeFile(
      fakeAzd,
      `#!/bin/sh
  printf '%s\n' "$*" >> "$IAC_COMPOSER_AZD_LOG"
  `,
    );
    await chmod(fakeAzd, 0o755);

    const cli = resolve("dist/cli.js");
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      IAC_COMPOSER_AZD_LOG: log,
    };
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "down", projectDirectory, "-e", "dev"], {
        env: environment,
      }),
      /Cleanup requires --force/,
    );
    await execFileAsync(
      process.execPath,
      [cli, "down", projectDirectory, "-e", "dev", "--force", "--purge"],
      { env: environment },
    );

    assert.equal(
      (await readFile(log, "utf8")).trim(),
      "down --environment dev --force --purge --no-prompt",
    );
  });
}

test("down refuses an unmarked azd project", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-down-unmarked-"));
  await writeFile(join(root, "azure.yaml"), JSON.stringify({ name: "other" }));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [resolve("dist/cli.js"), "down", root, "-e", "dev", "--force"],
    ),
    /Refusing cleanup/,
  );
});

test("down rejects a legacy imperative-deploy project with regeneration guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-down-legacy-"));
  await writeFile(
    join(root, "azure.yaml"),
    JSON.stringify({
      name: "legacy",
      metadata: { template: "imperative-deploy@1.0.0" },
      infra: {
        provider: "bicep",
        layers: [{ name: "shared", path: "./shared" }],
      },
    }),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [resolve("dist/cli.js"), "down", root, "-e", "dev", "--force"],
    ),
    /legacy imperative-deploy project.*Regenerate it with iac-composer/s,
  );
});

test("down refuses unknown ownership versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-down-unknown-"));
  await writeFile(
    join(root, "azure.yaml"),
    JSON.stringify({
      metadata: { template: "iac-compose@0.0.0" },
      infra: { layers: [{ name: "shared", path: "./shared" }] },
    }),
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [resolve("dist/cli.js"), "down", root, "-e", "dev", "--force"],
    ),
    /Refusing cleanup/,
  );
});