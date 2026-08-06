import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { createAppServiceContainerManifest } from "../src/index.js";

test("App Service manifest lets azd build, publish, and deploy source", () => {
  const manifest = createAppServiceContainerManifest({
    directory: ".generated/frontend",
    service: "frontend",
    resourceName: "chatbot-web",
    project: "/workspace/frontend",
    dockerfile: "Dockerfile",
    context: ".",
    registry: "registry.example",
    imageName: "chatbot",
    tag: "dev",
    environment: { RAG_SERVICE_SCOPE: "api://server/.default" },
  });

  assert.deepEqual(manifest, {
    name: "deploy-frontend",
    services: {
      frontend: {
        host: "appservice",
        language: "docker",
        resourceName: "chatbot-web",
        project: "/workspace/frontend",
        docker: {
          path: "Dockerfile",
          context: ".",
          registry: "registry.example",
          image: "chatbot",
          tag: "dev",
          remoteBuild: true,
        },
        env: { RAG_SERVICE_SCOPE: "api://server/.default" },
      },
    },
  });
  assert.equal("hooks" in manifest, false);
  assert.equal(JSON.stringify(manifest).includes('"image":"registry'), false);
});

test("Function container manifest uses azd's function target", () => {
  assert.deepEqual(
    createAppServiceContainerManifest({
      directory: ".generated/function-app",
      service: "function-app",
      host: "function",
      project: "/workspace/function",
      registry: "registry.example",
    }),
    {
      name: "deploy-function-app",
      requiredVersions: { azd: ">= 1.30.0" },
      services: {
        "function-app": {
          host: "function",
          language: "docker",
          project: "/workspace/function",
          docker: {
            path: "Dockerfile",
            context: ".",
            registry: "registry.example",
            image: "function-app",
            remoteBuild: true,
          },
        },
      },
    },
  );
});

test("chatbot components delegate container updates to azd", async () => {
  for (const component of ["agent-server", "function-app", "frontend"]) {
    const source = await readFile(
      resolve("examples/chatbot/src/components", component, "index.ts"),
      "utf8",
    );
    assert.match(source, /deployAppServiceContainer/);
    assert.match(source, /deployment\.dryRun/);
    assert.match(source, /prepareAppServiceContainer/);
    assert.doesNotMatch(source, /buildContainerImage|fromPackage|--from-package/);
    assert.doesNotMatch(source, /config["'],\s*["']container|webapp["']|restart["']/);
  }
});