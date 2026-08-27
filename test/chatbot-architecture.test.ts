import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const chatbotRoot = resolve("examples/chatbot");
const chatbotSourceRoot = resolve(chatbotRoot, "src");

test("chatbot owns deployment order and generates one hook-free azd project", async () => {
  const sourceFiles = await collectTypeScriptFiles(chatbotSourceRoot);
  const source = (
    await Promise.all(sourceFiles.map((path) => readFile(path, "utf8")))
  ).join("\n");
  const runtimeSource = (
    await Promise.all(
      sourceFiles
        .filter((path) => !path.endsWith("/provisioning.ts"))
        .map((path) => readFile(path, "utf8")),
    )
  ).join("\n");

  assert.doesNotMatch(source, /command:\s*["']azd["']/);
  assert.doesNotMatch(source, /deployment\/hooks/);
  assert.doesNotMatch(source, /azure\.yaml/);
  assert.doesNotMatch(source, /loadAzdEnv|persistEnv\(|\.hook\(/);
  assert.doesNotMatch(source, /workflow-definition\.json/);
  assert.doesNotMatch(
    runtimeSource,
    /getAccessToken|["']rest["']|graph\.microsoft\.com/,
  );
  assert.match(source, /getAzdProject/);
  assert.match(source, /deployAppServiceContainer/);
});

test("chatbot deployment keeps the authored service lifecycle order", async () => {
  const source = await readFile(resolve(chatbotSourceRoot, "deploy.ts"), "utf8");
  const expected = [
    "shared",
    "agent",
    "agentServer",
    "functionApp",
    "frontend",
    "logicApp",
  ];
  const positions = expected.map((name) => source.indexOf(`await ${name}(deployment`));

  assert.equal(positions.every((position) => position >= 0), true);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  for (const component of [
    "shared",
    "agent",
    "agent-server",
    "function-app",
    "frontend",
    "logic-app",
  ]) {
    assert.match(source, new RegExp(`(?:["']${component}["']|\\b${component}\\b):`));
  }
  assert.match(source, /deployment\.component/);
});

test("agent owns the bot identity consumed by frontend", async () => {
  const [agentProvisioning, frontendProvisioning] = await Promise.all([
    readFile(
      resolve(chatbotSourceRoot, "components/agent/provisioning.ts"),
      "utf8",
    ),
    readFile(
      resolve(chatbotSourceRoot, "components/frontend/provisioning.ts"),
      "utf8",
    ),
  ]);

  assert.match(agentProvisioning, /new UserAssignedIdentity/);
  assert.match(frontendProvisioning, /existing:\s*true/);
  assert.doesNotMatch(
    frontendProvisioning,
    /new UserAssignedIdentity\(stack, \{\s*name: frontendBaseName/,
  );
});

test("chatbot source is grouped into component folders", async () => {
  for (const component of [
    "shared",
    "agent",
    "agent-server",
    "function-app",
    "logic-app",
    "frontend",
  ]) {
    await access(
      resolve(chatbotSourceRoot, "components", component, "index.ts"),
    );
  }
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}