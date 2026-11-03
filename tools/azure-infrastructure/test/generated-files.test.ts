import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installGeneratedFiles } from "../src/generation/output/generated-files.js";

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
