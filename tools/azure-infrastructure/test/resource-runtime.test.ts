import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeployment, type Deployment } from "iac-composer";
import { teamsEnvironmentName } from "../src/runtime/services/teams.js";
import {
  deployResourceComponent,
  prepareResourceRequirements,
  resolveOutputBindings,
} from "../src/index.js";

test("prepares generated container components as source-backed azd services", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-resource-component-"));
  const generatedDirectory = join(root, ".generated");
  const deployment = createDeployment({
    projectDirectory: root,
    environment: "dev",
    dryRun: true,
    log: () => {},
  });
  delete process.env.backendBaseUrl;

  await deployResourceComponent(deployment, {
    component: "frontend",
    packageDirectory: root,
    generatedDirectory,
    source: "components/frontend",
    resources: [
      {
        id: "frontendCompute",
        kind: "container-host",
        requiredBy: ["frontend"],
        containerPort: 3978,
        configuration: {
          runtimeSettings: {
            BACKEND_BASE_URL: "${output.backendBaseUrl}",
          },
        },
      },
    ],
  });

  const manifest = JSON.parse(
    await readFile(join(generatedDirectory, "azure.yaml"), "utf8"),
  );
  assert.equal(manifest.services.frontend.host, "appservice");
  assert.equal(manifest.services.frontend.project, join(root, "components/frontend"));
  assert.equal(
    manifest.services.frontend.env.BACKEND_BASE_URL,
    "${backendBaseUrl}",
  );
  assert.equal(
    resolveOutputBindings("${output.backendBaseUrl}/ping", {
      backendBaseUrl: "https://backend.example",
    }),
    "https://backend.example/ping",
  );
});

test("contract adapters reject missing sources and unresolved output bindings", async () => {
  await assert.rejects(
    deployResourceComponent(createDeployment({ dryRun: true, log: () => {} }), {
      component: "api",
      packageDirectory: "/workspace",
      generatedDirectory: "/workspace/.generated",
      resources: [
        { id: "apiCompute", kind: "container-host", requiredBy: ["api"] },
      ],
    }),
    /Container resource 'apiCompute' requires a component source directory/,
  );
  assert.throws(
    () => resolveOutputBindings("${output.missing}", {}),
    /Deployment output 'missing' is not available/,
  );
  assert.equal(
    resolveOutputBindings("${output.missing}", {}, true),
    "${missing}",
  );
});

test("prepares hosted agents with the azd Foundry agent target", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-hosted-agent-"));
  const generatedDirectory = join(root, ".generated");
  const deployment = createDeployment({
    projectDirectory: root,
    environment: "dev",
    dryRun: true,
    log: () => {},
  });

  await deployResourceComponent(deployment, {
    component: "agent",
    kind: "hosted-agent",
    packageDirectory: root,
    generatedDirectory,
    source: "components/agent",
    resources: [
      {
        id: "agentCompute",
        kind: "container-host",
        requiredBy: ["agent"],
        source: "components/agent",
        configuration: {
          runtimeSettings: {
            AZURE_APPCONFIG_ENDPOINT: "${output.appConfigurationEndpoint}",
          },
        },
        produces: ["agentEndpoint", "agentIdentityPrincipalId"],
      },
    ],
  });

  const manifest = JSON.parse(
    await readFile(join(generatedDirectory, "azure.yaml"), "utf8"),
  );
  assert.equal(manifest.services.agent.host, "azure.ai.agent");
  assert.equal(manifest.services.agent.kind, "hosted");
  assert.equal(manifest.services.agent.startupCommand, "python3 -u init.py");
  assert.equal(
    manifest.services.agent.env.AZURE_APPCONFIG_ENDPOINT,
    "${AZURE_APPCONFIG_ENDPOINT}",
  );
  assert.doesNotMatch(JSON.stringify(manifest), /"host":"appservice"/);
});

test("isolates Teams state and rejects unresolved workflow placeholders", async () => {
  assert.equal(teamsEnvironmentName("dev"), "iac-composer-dev");
  assert.equal(teamsEnvironmentName("Feature/One"), "iac-composer-feature-one");

  const deployment = createDeployment({
    environment: "dev",
    log: () => {},
  });
  await assert.rejects(
    deployResourceComponent(deployment, {
      component: "logic-app",
      packageDirectory: "/workspace",
      generatedDirectory: "/workspace/.generated",
      resources: [
        {
          id: "workflow",
          kind: "workflow-host",
          requiredBy: ["logic-app"],
          parameters: {
            parameters: {
              teamsGroupId: { value: "<teams-group-id>" },
            },
          },
        },
      ],
    }),
    /cannot be enabled.*teams-group-id/,
  );
});

test("preserves an authorized Teams connection during reprovisioning", async () => {
  const previousSubscription = process.env.AZURE_SUBSCRIPTION_ID;
  const previousResourceGroup = process.env.AZURE_RESOURCE_GROUP;
  const previousCreate = process.env.DEPLOY_CREATE_RESOURCE_TEAMSCONNECTION;
  process.env.AZURE_SUBSCRIPTION_ID = "subscription";
  process.env.AZURE_RESOURCE_GROUP = "resources";
  let args: readonly string[] = [];
  const deployment = {
    capture: async (command: { args?: readonly string[] }) => {
      args = command.args ?? [];
      return "Connected\n";
    },
  } as unknown as Deployment;
  try {
    await prepareResourceRequirements(deployment, {
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["logic-app"] },
      resources: [
        {
          id: "teamsConnection",
          kind: "authorized-api-connection",
          requiredBy: ["logic-app"],
          authorization: "interactive",
        },
      ],
    });

    assert.equal(process.env.DEPLOY_CREATE_RESOURCE_TEAMSCONNECTION, "false");
    assert.deepEqual(args.slice(args.indexOf("--name"), args.indexOf("--name") + 2), [
      "--name",
      "teams",
    ]);
  } finally {
    restoreEnvironment("AZURE_SUBSCRIPTION_ID", previousSubscription);
    restoreEnvironment("AZURE_RESOURCE_GROUP", previousResourceGroup);
    restoreEnvironment("DEPLOY_CREATE_RESOURCE_TEAMSCONNECTION", previousCreate);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}