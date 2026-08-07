import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  createAgentAzdManifest,
  parseAgentVersion,
} from "../examples/chatbot/src/components/agent/index.js";

test("hosted agent manifest lets azd build and deploy the container source", () => {
  const manifest = createAgentAzdManifest({
    dockerfile: "/workspace/agent/agents/chat_agent/Dockerfile",
    context: "/workspace/agent",
    registry: "registry.example",
    tag: "dev",
  });
  assert.deepEqual(manifest, {
    name: "chatbot-agent",
    services: {
      agent: {
        project: ".",
        host: "azure.ai.agent",
        language: "python",
        docker: {
          path: "/workspace/agent/agents/chat_agent/Dockerfile",
          context: "/workspace/agent",
          registry: "registry.example",
          image: "azure-sdk-chat-agent",
          tag: "dev",
          remoteBuild: true,
        },
        kind: "hosted",
        name: "azure-sdk-chat-agent",
        description: "Azure SDK Q&A hosted agent",
        protocols: [{ protocol: "responses", version: "2.0.0" }],
        config: { container: { resources: { cpu: "0.5", memory: "1Gi" } } },
        container: { resources: { cpu: "0.5", memory: "1Gi" } },
        startupCommand: "python init.py",
        env: {
          AZURE_APPCONFIG_ENDPOINT: "${AZURE_APPCONFIG_ENDPOINT}",
        },
      },
    },
  });
  assert.equal("hooks" in manifest, false);
});

test("hosted agent delegates its source build to azd deploy", async () => {
  const source = await readFile(
    resolve("examples/chatbot/src/components/agent/index.ts"),
    "utf8",
  );
  assert.match(source, /project\.deploy\("agent"\)/);
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

test("agent status parser preserves the azd show identity contract", () => {
  assert.deepEqual(
    parseAgentVersion(
      JSON.stringify({
        name: "azure-sdk-chat-agent",
        version: "7",
        status: "active",
        instance_identity: { principal_id: "principal-id" },
      }),
    ),
    {
      name: "azure-sdk-chat-agent",
      version: "7",
      status: "active",
      instance_identity: { principal_id: "principal-id" },
    },
  );
  assert.throws(
    () => parseAgentVersion('{"name":"agent"}'),
    /invalid agent version/,
  );
});