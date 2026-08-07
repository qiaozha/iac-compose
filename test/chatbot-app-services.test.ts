import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { createAppServiceContainerManifest } from "../src/index.js";
import {
  frontendAccessRestrictionArgs,
  frontendAccessRestrictionQueryArgs,
  frontendOutboundIpQueryArgs,
} from "../examples/chatbot/src/components/shared/frontend-access.js";

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

test("frontend deployment always provisions without publishing the Teams app", async () => {
  const [source, environmentSource] = await Promise.all([
    readFile(
      resolve("examples/chatbot/src/components/frontend/index.ts"),
      "utf8",
    ),
    readFile(resolve("examples/chatbot/src/environments/dev.json"), "utf8"),
  ]);
  const provision = source.indexOf(
    '"@microsoft/teamsapp-cli",\n        "provision"',
  );
  const publish = source.indexOf(
    '"@microsoft/teamsapp-cli",\n        "publish"',
  );

  assert.notEqual(provision, -1);
  assert.equal(publish, -1);
  assert.doesNotMatch(source, /SKIP_TEAMS_PROVISION|TEAMS_PUBLISH/);
  assert.match(source, /TEAMS_APP_MANIFEST_ID/);
  assert.match(source, /TEAMS_APP_ID: teamsInputValues\.TEAMS_APP_ID/);
  assert.equal(
    JSON.parse(environmentSource).TEAMS_APP_MANIFEST_ID,
    "9d620152-6b1b-44f2-9635-b1f120c93c4a",
  );
});

test("frontend allows its outbound traffic through the agent server", () => {
  assert.deepEqual(
    frontendOutboundIpQueryArgs("subscription", "resources", "frontend"),
    [
      "webapp",
      "show",
      "--subscription",
      "subscription",
      "--resource-group",
      "resources",
      "--name",
      "frontend",
      "--query",
      "possibleOutboundIpAddresses",
      "--output",
      "tsv",
    ],
  );
  assert.deepEqual(
    frontendAccessRestrictionQueryArgs(
      "subscription",
      "resources",
      "server",
    ),
    [
      "webapp",
      "config",
      "access-restriction",
      "show",
      "--subscription",
      "subscription",
      "--resource-group",
      "resources",
      "--name",
      "server",
      "--query",
      "ipSecurityRestrictions",
      "--output",
      "json",
    ],
  );
  assert.deepEqual(
    frontendAccessRestrictionArgs(
      "subscription",
      "resources",
      "server",
      "203.0.113.10/32",
      200,
    ),
    [
      "webapp",
      "config",
      "access-restriction",
      "add",
      "--subscription",
      "subscription",
      "--resource-group",
      "resources",
      "--name",
      "server",
      "--rule-name",
      "Allow frontend outbound 200",
      "--action",
      "Allow",
      "--ip-address",
      "203.0.113.10/32",
      "--priority",
      "200",
    ],
  );
});
