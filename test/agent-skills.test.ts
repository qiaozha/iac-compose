import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";
import { describeRuntimeCapabilities } from "../src/index.js";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillSources = [".github/skills/iac-composer"];

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function validateSkill(directory: string): Promise<Record<string, unknown>> {
  const contents = await readFile(join(directory, "SKILL.md"), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(contents);
  assert.ok(frontmatter);
  const metadata = object(parse(frontmatter[1]));
  assert.equal(metadata.name, directory.split(/[\\/]/).at(-1));
  assert.ok(typeof metadata.description === "string");
  assert.ok(metadata.description.length > 0 && metadata.description.length <= 1024);
  assert.notEqual(metadata["disable-model-invocation"], true);
  for (const match of contents.matchAll(/\]\(((?:\.\/)?references\/[^)#]+)(?:#[^)]*)?\)/g)) {
    await access(resolve(directory, match[1]));
  }
  return metadata;
}

test("the implementation skill advertises provisioning TypeScript without a planner dependency", async () => {
  const runtime = await validateSkill(resolve(root, skillSources[0]));
  assert.match(String(runtime.description), /@azure\/provisioning/);
  assert.match(String(runtime.description), /any planner or the user/);
  assert.doesNotMatch(String(runtime.description), /azure-infrastructure-intent|already exists/);
  assert.equal(typeof describeRuntimeCapabilities("overview"), "object");
});

test("actual runtime package owns its skill, MCP and consumer setup without a planner package", async () => {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { cwd: root });
  const packed: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(packed) && packed.length === 1);
  const files = object(packed[0]).files;
  assert.ok(Array.isArray(files));
  const paths = files.map((entry) => object(entry).path);
  assert.ok(paths.includes(".github/skills/iac-composer/SKILL.md"));
  assert.ok(paths.includes(".github/skills/iac-composer/references/direct-authoring.md"));
  assert.ok(paths.includes("dist/discovery.js"));
  assert.ok(paths.includes("dist/mcp/cli.js"));
  assert.ok(paths.includes("agent-setup/AGENTS.md.template"));
  const manifest = object(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  assert.equal(Object.hasOwn(object(manifest.dependencies), "azure-infrastructure"), false);
  assert.equal(object(manifest.bin)["iac-composer-mcp"], "dist/mcp/cli.js");
});

test("the canonical implementation skill installs alone in a consumer workspace", async (t) => {
  try {
    await execFileAsync("gh", ["skill", "install", "--help"]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      t.skip("GitHub CLI is not installed; no real installation was verified.");
      return;
    }
    throw error;
  }
  const consumer = await mkdtemp(join(tmpdir(), "iac-composer-skill-install-"));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet", consumer]);
  await mkdir(join(consumer, "gh-config"));
  for (const source of skillSources) {
    await execFileAsync("gh", [
      "skill", "install", root, basename(source),
      "--from-local", "--agent", "codex", "--scope", "project", "--allow-hidden-dirs",
    ], {
      cwd: consumer,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: join(consumer, "gh-config") },
    });
    const installed = join(consumer, ".agents/skills", basename(source));
    await validateSkill(installed);
    const body = (contents: string) => contents.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    assert.equal(body(await readFile(join(installed, "SKILL.md"), "utf8")),
      body(await readFile(join(root, source, "SKILL.md"), "utf8")));
  }
  for (const duplicate of [".github/skills", ".claude/skills"]) {
    await assert.rejects(access(join(consumer, duplicate)), { code: "ENOENT" });
  }
  await assert.rejects(access(join(consumer, ".agents/skills/azure-infrastructure-intent")), { code: "ENOENT" });
});
