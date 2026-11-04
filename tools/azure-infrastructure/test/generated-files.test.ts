import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installGeneratedFiles } from "../src/generation/output/generated-files.js";
import { createGenerationWorkspace } from "../src/generation/workspace.js";
import { IacComposerError } from "iac-composer";

test("code generation rejects legacy deploy-js ownership state", async () => {
  const output = await mkdtemp(join(tmpdir(), "iac-composer-codegen-legacy-"));
  await writeFile(
    join(output, ".deploy-js-codegen.json"),
    `${JSON.stringify({ version: 1, files: ["stale.ts"] })}\n`,
  );

  await assert.rejects(
    installGeneratedFiles(output, new Map([["deploy.ts", "export {};\n"]])),
    /Legacy deploy-js generated output/,
  );
  await assert.rejects(access(join(output, "deploy.ts")), { code: "ENOENT" });
});

test("strict generation preflights every owned path before deleting prior output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-strict-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "deployment");
  await mkdir(output);
  const workspace = await createGenerationWorkspace(root);
  await writeFile(join(output, "old.ts"), "previous source");
  await writeFile(join(root, "customer.ts"), "customer source");
  for (const manifest of [
    { version: 2, files: ["old.ts"] },
    { version: 1, files: ["old.ts", "../customer.ts"] },
    { version: 1, files: ["old.ts", "./.iac-composer-codegen.json"] },
  ]) {
    await writeFile(join(output, ".iac-composer-codegen.json"), JSON.stringify(manifest));
    await assert.rejects(installGeneratedFiles(output, new Map([["new.ts", "new"]]), { workspace }));
    assert.equal(await readFile(join(output, "old.ts"), "utf8"), "previous source");
    assert.equal(await readFile(join(root, "customer.ts"), "utf8"), "customer source");
  }
});

test("strict generation refuses redirected writes and file/directory conflicts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-strict-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "deployment");
  await mkdir(output);
  const workspace = await createGenerationWorkspace(root);
  await writeFile(join(root, "customer.ts"), "customer source");
  await writeFile(join(output, ".iac-composer-codegen.json"), JSON.stringify({ version: 1, files: ["owned.ts"] }));
  await symlink(join(root, "customer.ts"), join(output, "owned.ts"));
  await assert.rejects(installGeneratedFiles(output, new Map([["owned.ts", "replacement"]]), { workspace }),
    (error: unknown) => error instanceof IacComposerError && error.diagnostic.code === "OUTPUT_SYMLINK_REFUSED");
  await unlink(join(output, "owned.ts"));
  await link(join(root, "customer.ts"), join(output, "owned.ts"));
  await assert.rejects(installGeneratedFiles(output, new Map([["owned.ts", "replacement"]]), { workspace }),
    (error: unknown) => error instanceof IacComposerError && error.diagnostic.code === "OUTPUT_CONFLICT");
  assert.equal(await readFile(join(root, "customer.ts"), "utf8"), "customer source");
  await unlink(join(output, "owned.ts"));
  await writeFile(join(output, ".iac-composer-codegen.json"), JSON.stringify({ version: 1, files: [] }));
  await assert.rejects(installGeneratedFiles(output, new Map([["nested", "file"], ["nested/file.ts", "child"]]), { workspace }),
    (error: unknown) => error instanceof IacComposerError && error.diagnostic.code === "OUTPUT_CONFLICT");
  await assert.rejects(access(join(output, "nested")), { code: "ENOENT" });
});

test("generation migrates previous manifests and preserves customer-owned files", async () => {
  const output = await mkdtemp(join(tmpdir(), "iac-composer-codegen-state-"));
  try {
    await writeFile(join(output, "old.ts"), "old");
    await writeFile(join(output, "stale.ts"), "stale");
    await writeFile(join(output, "customer.ts"), "owned");
    await writeFile(
      join(output, ".iac-compose-codegen.json"),
      JSON.stringify({ version: 1, files: ["old.ts"] }),
    );
    await writeFile(
      join(output, ".iac-composer-codegen.json"),
      JSON.stringify({ version: 1, files: ["stale.ts"] }),
    );
    await installGeneratedFiles(output, new Map([["deploy.ts", "export {};\n"]]));
    assert.equal(await readFile(join(output, "customer.ts"), "utf8"), "owned");
    for (const file of ["old.ts", "stale.ts", ".iac-compose-codegen.json"]) {
      await assert.rejects(access(join(output, file)), { code: "ENOENT" });
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(output, ".iac-composer-codegen.json"), "utf8")),
      { version: 1, files: ["deploy.ts"] },
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
