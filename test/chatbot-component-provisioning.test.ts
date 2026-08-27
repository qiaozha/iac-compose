import assert from "node:assert/strict";
import {
  access,
  readFile,
  readdir,
} from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { outputBicep as sharedBicep } from "../examples/chatbot/src/components/shared/provisioning.js";
import { outputBicep as agentBicep } from "../examples/chatbot/src/components/agent/provisioning.js";
import { outputBicep as frontendBicep } from "../examples/chatbot/src/components/frontend/provisioning.js";
import { outputBicep as agentServerBicep } from "../examples/chatbot/src/components/agent-server/provisioning.js";
import { outputBicep as functionAppBicep } from "../examples/chatbot/src/components/function-app/provisioning.js";
import { outputBicep as logicAppBicep } from "../examples/chatbot/src/components/logic-app/provisioning.js";

interface RenderedFile {
  readonly path: string;
  readonly contents: string;
}

const components: ReadonlyArray<{
  readonly name: string;
  readonly directory: string;
  readonly files: readonly RenderedFile[];
  readonly outputs: readonly string[];
}> = [
  {
    name: "shared",
    directory: "shared",
    files: sharedBicep,
    outputs: [
      "AZURE_RESOURCE_GROUP",
      "MANAGED_IDENTITY_PRINCIPAL_ID",
      "STORAGE_ACCOUNT_NAME",
      "CONTAINER_REGISTRY_LOGIN_SERVER",
      "AZURE_APPCONFIG_ENDPOINT",
    ],
  },
  {
    name: "agent",
    directory: "agent",
    files: agentBicep,
    outputs: [
      "AI_RESOURCE_NAME",
      "AI_PROJECT_NAME",
      "AZURE_AI_PROJECT_ID",
      "FOUNDRY_PROJECT_ENDPOINT",
      "BOT_IDENTITY_NAME",
      "BOT_IDENTITY_PRINCIPAL_ID",
    ],
  },
  {
    name: "frontend",
    directory: "frontend",
    files: frontendBicep,
    outputs: ["BOT_BASE_URL", "FRONTEND_SITE_NAME"],
  },
  {
    name: "agent-server",
    directory: "agent-server",
    files: agentServerBicep,
    outputs: ["SERVER_BASE_URL", "AGENT_SERVER_SITE_NAME"],
  },
  {
    name: "function-app",
    directory: "function-app",
    files: functionAppBicep,
    outputs: ["FUNCTION_APP_NAME"],
  },
  {
    name: "logic-app",
    directory: "logic-app",
    files: logicAppBicep,
    outputs: ["LOGIC_APP_WORKFLOW_NAME", "TEAMS_CONNECTION_NAME"],
  },
];

test("each component owns a direct provisioning lifecycle call", async () => {
  for (const component of components) {
    const source = await readFile(
      resolve(
        "examples/chatbot/src/components",
        component.directory,
        "index.ts",
      ),
      "utf8",
    );
    assert.match(source, /deployment\.provision\(/, component.name);
  }
});

test("component provisioners emit library-generated entry and parameter files", () => {
  for (const component of components) {
    const main = component.files.find((file) => file.path === "main.bicep");
    const parameters = component.files.find(
      (file) => file.path === "main.bicepparam",
    );
    assert.ok(main?.contents.trim(), `${component.name} main.bicep`);
    assert.ok(
      parameters?.contents.trim(),
      `${component.name} main.bicepparam`,
    );
    for (const output of component.outputs) {
      assert.match(main.contents, new RegExp(`output ${output} string`));
    }
  }
});

test("agent creates the bot identity and frontend references it", () => {
  const agentMain = agentBicep.find((file) => file.path === "main.bicep");
  const frontendMain = frontendBicep.find((file) => file.path === "main.bicep");
  assert.ok(agentMain);
  assert.ok(frontendMain);
  assert.match(agentMain.contents, /disableLocalAuth: true/);
  assert.match(
    agentMain.contents,
    /Microsoft\.CognitiveServices\/accounts\/connections@2026-05-15-preview/,
  );
  assert.match(
    agentMain.contents,
    /Microsoft\.CognitiveServices\/accounts\/projects\/connections@2026-05-15-preview/,
  );
  assert.match(
    agentMain.contents,
    /resource userAssignedIdentity '[^']+' = \{/,
  );
  assert.doesNotMatch(
    agentMain.contents,
    /resource userAssignedIdentity '[^']+' existing =/,
  );
  assert.match(
    frontendMain.contents,
    /resource userAssignedIdentity '[^']+' existing = \{/,
  );
});

test("frontend monitoring resources target their owning resources", () => {
  const frontendMain = frontendBicep.find((file) => file.path === "main.bicep");
  assert.ok(frontendMain);
  assert.match(
    frontendMain.contents,
    /resource diagnosticSetting[\s\S]*?scope: site/,
  );
  assert.match(
    frontendMain.contents,
    /'hidden-link: \/app-insights-resource-id': component\.id/,
  );
  assert.match(
    frontendMain.contents,
    /tags: json\('\{"hidden-link:\$\{component\.id\}":"Resource"\}'\)/,
  );
  assert.doesNotMatch(frontendMain.contents, /hidden-link:\\\$\{component\.id\}/);
});

test("Logic App resource names have deterministic defaults", () => {
  const main = logicAppBicep.find((file) => file.path === "main.bicep");
  const parameters = logicAppBicep.find(
    (file) => file.path === "main.bicepparam",
  );
  assert.ok(main);
  assert.ok(parameters);
  assert.match(main.contents, /param integrationAccountName string = ''/);
  assert.match(main.contents, /'azuresdkqabot-logicapp-\$\{suffix\}'/);
  assert.match(
    parameters.contents,
    /readEnvironmentVariable\('INTEGRATION_ACCOUNT_NAME', ''\)/,
  );
  assert.match(
    parameters.contents,
    /readEnvironmentVariable\('LOGIC_APP_WORKFLOW_NAME', ''\)/,
  );
});

test("Logic App outputs persist before Teams consent is required", async () => {
  const source = await readFile(
    resolve("examples/chatbot/src/components/logic-app/index.ts"),
    "utf8",
  );
  const persistIndex = source.indexOf("await persistEnvironment");
  const consentIndex = source.indexOf("await requireTeamsConnectionConsent");
  assert.notEqual(persistIndex, -1);
  assert.notEqual(consentIndex, -1);
  assert.ok(persistIndex < consentIndex);
});

test("Function App exposes code from its container image", () => {
  const functionMain = functionAppBicep.find(
    (file) => file.path === "main.bicep",
  );
  assert.ok(functionMain);
  assert.match(
    functionMain.contents,
    /name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE'\s+value: 'false'/,
  );
});

test("agent server leaves only its readiness endpoint outside Easy Auth", () => {
  const agentServerMain = agentServerBicep.find(
    (file) => file.path === "main.bicep",
  );
  assert.ok(agentServerMain);
  assert.match(
    agentServerMain.contents,
    /excludedPaths:\s*\[\s*'\/ping'\s*\]/,
  );
});

test("chatbot provisioning paths stay within the example", async () => {
  const paths = await readFile(
    resolve("examples/chatbot/src/runtime/paths.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    paths,
    /js-provisioning-lib|provisioningRoot|provisioningDemo|provisioningArtifacts/,
  );
  assert.doesNotMatch(paths, /\.generated\/infra|generated\w+Infra/);
  assert.match(paths, /generatedRoot = resolve\(exampleRoot, "\.generated"\)/);
  assert.doesNotMatch(paths, /stateRoot|\.state/);
  for (const component of [
    "shared",
    "agent",
    "frontend",
    "agent-server",
    "function-app",
    "identity",
    "logic-app",
  ]) {
    assert.match(
      paths,
      new RegExp(`resolve\\(\\s*generatedRoot,\\s*"${component}"`),
    );
  }
});

test("runtime configuration does not seed Cognitive Services account keys", async () => {
  const source = await readFile(
    resolve("examples/chatbot/src/components/shared/configuration.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /AOAI-CHAT-COMPLETIONS-API-KEY/);
  assert.doesNotMatch(source, /"cognitiveservices"/);
});

test("chatbot installs provisioning libraries from GitHub release assets", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve("examples/chatbot/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const packageLock = JSON.parse(
    await readFile(resolve("examples/chatbot/package-lock.json"), "utf8"),
  ) as {
    packages?: Record<string, { resolved?: string; integrity?: string }>;
  };
  const provisioningDependencies = Object.entries(
    packageJson.dependencies ?? {},
  ).filter(([name]) => name.startsWith("@azure/provisioning-"));
  assert.ok(provisioningDependencies.length > 0);
  for (const [name, value] of provisioningDependencies) {
    const packageName = name.slice("@azure/".length);
    const releaseUrl =
      `https://github.com/Azure/js-provisioning-lib/releases/download/` +
      `%40azure/${packageName}%400.1.0/azure-${packageName}-0.1.0.tgz`;
    assert.equal(value, releaseUrl, name);
    const lockedPackage = packageLock.packages?.[`node_modules/${name}`];
    assert.equal(lockedPackage?.resolved, releaseUrl, name);
    assert.match(lockedPackage?.integrity ?? "", /^sha512-/, name);
  }
});

test("chatbot imports imperative-deploy directly through its local package", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve("examples/chatbot/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(packageJson.dependencies?.["imperative-deploy"], "file:../..");

  const files = await collectTypeScriptFiles(resolve("examples/chatbot/src"));
  const source = (
    await Promise.all(files.map((file) => readFile(file, "utf8")))
  ).join("\n");
  assert.match(source, /from ["']imperative-deploy["']/);
  assert.doesNotMatch(source, /from ["'][^"']*deployment\.js["']/);
  assert.doesNotMatch(source, /\.\.\/\.\.\/\.\.\/src/);
  await assert.rejects(
    access(resolve("examples/chatbot/src/deployment.ts")),
    { code: "ENOENT" },
  );

  const tsconfig = await readFile(
    resolve("examples/chatbot/tsconfig.json"),
    "utf8",
  );
  assert.doesNotMatch(tsconfig, /\.\.\/\.\.\/src/);
});

test("chatbot provisioning has no sibling source imports or handwritten Bicep", async () => {
  const files = await collectTypeScriptFiles(resolve("examples/chatbot"));
  const source = (
    await Promise.all(files.map((file) => readFile(file, "utf8")))
  ).join("\n");
  assert.doesNotMatch(source, /js-provisioning-lib|packages\/[^"']+\/dist/);
  assert.doesNotMatch(
    source,
    /const\s+(?:template|parameters|bicepConfig)\s*=\s*`|targetScope\s*=\s*['"]|resource\s+\w+\s+['"]Microsoft\./,
  );
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".generated") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}