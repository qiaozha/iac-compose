import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  createAgentServiceConfiguration,
} from "../examples/chatbot/src/components/agent/index.js";

test("chatbot supplies its runtime configuration to its application-owned agent lifecycle", () => {
  const configuration = createAgentServiceConfiguration({
    registry: "registry.example",
    tag: "dev",
    appConfigurationEndpoint: "https://customer-config.azconfig.io",
  });
  assert.deepEqual(configuration.docker, {
    path: "agents/chat_agent/Dockerfile",
    context: ".",
    registry: "registry.example",
    image: "azure-sdk-chat-agent",
    tag: "dev",
    remoteBuild: true,
  });
  assert.equal(configuration.language, "python");
  assert.equal(configuration.name, "azure-sdk-chat-agent");
  assert.equal(configuration.description, "Azure SDK Q&A hosted agent");
  assert.equal(configuration.startupCommand, "python init.py");
  assert.deepEqual(configuration.container, { cpu: "0.5", memory: "1Gi" });
  assert.deepEqual(configuration.protocols, [{ protocol: "responses", version: "2.0.0" }]);
  assert.deepEqual(configuration.environment, {
    AZURE_APPCONFIG_ENDPOINT: "https://customer-config.azconfig.io",
  });
});

test("hosted agent delegates its source build to azd deploy", async () => {
  const source = await readFile(
    resolve("examples/chatbot/src/components/agent/index.ts"),
    "utf8",
  );
  assert.match(source, /deployHostedAgentService\(deployment/);
  assert.match(source, /provision: \{\s*layer: generatedAgentLayer/);
  assert.match(source, /configuration: async \(outputs\)/);
  assert.doesNotMatch(source, /buildContainerImage|fromPackage|--from-package/);
});

test("agent grants the server identity Foundry runtime access", async () => {
  const source = await readFile(
    resolve("examples/chatbot/src/components/agent/index.ts"),
    "utf8",
  );
  assert.match(source, /53ca6127-db72-4b80-b1b0-d745d6d5456d/);
  assert.match(source, /requiredEnv\("MANAGED_IDENTITY_PRINCIPAL_ID"\)/);
  assert.match(source, /ensureAgentServerFoundryAccess\(deployment\)/);
  assert.match(source, /ensureRoleAssignment/);
});
