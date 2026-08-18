import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeployment } from "../src/index.js";
import { renderResourceRequirements } from "../src/resource-contract.js";
import {
  appConfigurationKeySetArgs,
  createHostedAgentManifest,
  deployResourceComponent,
  enableWorkflowDeployment,
  parseHostedAgentVersion,
  prepareResourceRequirements,
  resolveOutputBindings,
  teamsEnvironmentName,
} from "../src/resource-runtime.js";

test("updates hosted-agent configuration through App Configuration data plane", () => {
  assert.deepEqual(
    appConfigurationKeySetArgs(
      "subscription-id",
      "configuration-store",
      "AI_FOUNDRY_AGENT_VERSION",
      "2",
    ),
    [
      "appconfig",
      "kv",
      "set",
      "--subscription",
      "subscription-id",
      "--name",
      "configuration-store",
      "--auth-mode",
      "login",
      "--key",
      "AI_FOUNDRY_AGENT_VERSION",
      "--value",
      "2",
      "--yes",
      "--output",
      "none",
    ],
  );
});

test("renders resource requirements and resolves output bindings", () => {
  const files = renderResourceRequirements(
    {
      schemaVersion: "1.0",
      solution: {
        name: "contoso-support",
        enabledComponents: ["backend", "frontend", "logic-app"],
      },
      resources: [
        {
          id: "foundryProject",
          kind: "ai-project",
          requiredBy: ["backend"],
          configuration: { model: "gpt-4.1-mini" },
          produces: ["foundryProjectEndpoint", "agentName", "agentVersion"],
        },
        {
          id: "stateStore",
          kind: "document-database",
          requiredBy: ["backend"],
          configuration: {
            database: "support",
            containers: [
              { name: "messages", partitionKey: "/conversationId" },
            ],
          },
          produces: ["cosmosEndpoint", "cosmosDatabase"],
        },
        {
          id: "feedbackStorage",
          kind: "object-storage",
          requiredBy: ["backend"],
          configuration: { containers: ["feedback"] },
          produces: ["storageBlobEndpoint"],
        },
        {
          id: "runtimeConfiguration",
          kind: "configuration-store",
          requiredBy: ["backend"],
          configuration: {
            values: { AZURE_COSMOSDB_ENDPOINT: "${output.cosmosEndpoint}" },
          },
          produces: ["appConfigurationEndpoint"],
          access: [
            {
              principalOutput: "backendIdentityPrincipalId",
              role: "App Configuration Data Reader",
            },
          ],
        },
        {
          id: "backendCompute",
          kind: "container-host",
          requiredBy: ["backend"],
          source: "components/backend",
          containerPort: 8080,
          healthPath: "/ping",
          authentication: "managed-identity",
          configuration: {
            runtimeSettings: {
              AZURE_APPCONFIG_ENDPOINT: "${output.appConfigurationEndpoint}",
            },
          },
          produces: [
            "backendBaseUrl",
            "backendAudience",
            "backendIdentityClientId",
            "backendIdentityPrincipalId",
            "backendIdentityResourceId",
          ],
        },
        {
          id: "botIdentity",
          kind: "bot-identity",
          requiredBy: ["frontend"],
          produces: ["botClientId", "botIdentityResourceId", "tenantId"],
        },
        {
          id: "teamsConnection",
          kind: "authorized-api-connection",
          requiredBy: ["logic-app"],
          authorization: "interactive",
          produces: ["teamsConnectionResourceId"],
        },
        {
          id: "autoReplyWorkflow",
          kind: "workflow-host",
          requiredBy: ["logic-app"],
          source: "components/logic-app/template.json",
          parameters: {
            parameters: {
              backendBaseUrl: { value: "${output.backendBaseUrl}" },
              teamsConnectionResourceId: {
                value: "${output.teamsConnectionResourceId}",
              },
            },
          },
        },
      ],
    },
    {
      templates: {
        autoReplyWorkflow: {
          $schema:
            "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
          contentVersion: "1.0.0.0",
          parameters: {
            logicAppName: { type: "string" },
            backendBaseUrl: { type: "string" },
            teamsConnectionResourceId: { type: "string" },
          },
          resources: [],
        },
      },
    },
  );

  const bicep = files.find((file) => file.path === "main.bicep")?.contents ?? "";
  assert.match(bicep, /Microsoft\.DocumentDB\/databaseAccounts/);
  assert.match(bicep, /options: \{ throughput: 400 \}/);
  assert.match(
    bicep,
    /output foundryProjectEndpoint string = 'https:\/\//,
  );
  assert.match(bicep, /Microsoft\.AppConfiguration\/configurationStores/);
  assert.match(bicep, /Microsoft\.Web\/sites/);
  assert.match(bicep, /Microsoft\.Web\/sites\/config/);
  assert.match(bicep, /Microsoft\.Graph\/applications@v1\.0/);
  assert.match(bicep, /Microsoft\.Graph\/servicePrincipals@v1\.0/);
  assert.match(
    bicep,
    /identifierUris: \['api:\/\/contoso-support-backendcompute-\$\{suffix\}'\]/,
  );
  assert.match(
    bicep,
    /output backendAudience string = 'api:\/\/contoso-support-backendcompute-\$\{suffix\}'/,
  );
  assert.match(bicep, /name: 'authsettingsV2'/);
  assert.match(bicep, /requireAuthentication: true/);
  assert.match(bicep, /excludedPaths: \['\/ping'\]/);
  assert.match(bicep, /microsoftgraph\/v1\.0:1\.0\.0/);
  assert.match(bicep, /Microsoft\.BotService\/botServices/);
  assert.match(bicep, /Microsoft\.Web\/connections/);
  assert.match(bicep, /resource teamsConnection[^\n]+ = if \(createTeamsConnection\)/);
  assert.match(bicep, /name: 'teams'/);
  assert.match(
    bicep,
    /output teamsConnectionResourceId string = resourceId\('Microsoft\.Web\/connections', 'teams'\)/,
  );
  assert.match(bicep, /module autoReplyWorkflow/);
  assert.match(bicep, /output backendBaseUrl string/);
  assert.match(bicep, /name: 'contososupportregistry\$\{suffix\}'/);
  assert.match(
    bicep,
    /resource feedbackStorage[\s\S]*?name: '[a-z0-9]+\$\{suffix\}'/,
  );
  assert.doesNotMatch(bicep, /name: 'contoso-support(?:registry|fee)/);
  assert.doesNotMatch(bicep, /\$\{output\./);
  assert.ok(
    files.some((file) => file.path === "templates/autoReplyWorkflow.json"),
  );
  const parameters =
    files.find((file) => file.path === "main.bicepparam")?.contents ?? "";
  assert.match(parameters, /DEPLOY_CREATE_RESOURCE_TEAMSCONNECTION/);
});

test("limits rendered Azure Bot names to 42 characters", () => {
  const files = renderResourceRequirements({
    schemaVersion: "1.0",
    solution: {
      name: "azure-sdk-engineering-assistant",
      enabledComponents: ["frontend"],
    },
    resources: [
      {
        id: "botIdentity",
        kind: "bot-identity",
        requiredBy: ["frontend"],
        produces: ["botClientId", "botIdentityResourceId", "tenantId"],
      },
    ],
  });
  const bicep = files.find((file) => file.path === "main.bicep")?.contents ?? "";
  const match = bicep.match(
    /resource botIdentityBot[\s\S]+?name: '([^']+)'/,
  );
  assert.ok(match);
  assert.ok(match[1].replace("${suffix}", "abcdef").length <= 42);
});

test("rejects unsupported resource kinds", () => {
  assert.throws(
    () =>
      renderResourceRequirements({
        schemaVersion: "1.0",
        solution: { name: "unsupported", enabledComponents: ["api"] },
        resources: [
          { id: "queue", kind: "mystery-queue", requiredBy: ["api"] },
        ],
      }),
    /Unsupported resource kind 'mystery-queue'/,
  );
});

test("defers hosted agent identity outputs and access grants", () => {
  const files = renderResourceRequirements(
    {
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["agent"] },
      resources: [
        {
          id: "foundryProject",
          kind: "ai-project",
          requiredBy: ["agent"],
          produces: ["foundryProjectEndpoint", "agentName", "agentVersion"],
          access: [
            {
              principalOutput: "agentIdentityPrincipalId",
              role: "Azure AI User",
            },
          ],
        },
        {
          id: "agentCompute",
          kind: "container-host",
          requiredBy: ["agent"],
          source: "components/agent",
          produces: ["agentEndpoint", "agentIdentityPrincipalId"],
        },
        {
          id: "runtimeConfiguration",
          kind: "configuration-store",
          requiredBy: ["agent"],
          configuration: {
            values: {
              AI_FOUNDRY_AGENT_VERSION: "${output.agentVersion}",
            },
          },
          produces: ["appConfigurationEndpoint"],
        },
      ],
    },
    { componentKinds: { agent: "hosted-agent" } },
  );
  const bicep = files.find((file) => file.path === "main.bicep")?.contents ?? "";

  assert.doesNotMatch(bicep, /resource agentComputeSite/);
  assert.match(bicep, /output agentEndpoint string = ''/);
  assert.match(bicep, /output agentVersion string = ''/);
  assert.doesNotMatch(bicep, /name: 'AI_FOUNDRY_AGENT_VERSION'/);
  assert.match(
    bicep,
    /output DEPLOY_RESOURCE_FOUNDRYPROJECT_ACCESS_SCOPE string = foundryProjectProject.id/,
  );
  assert.match(bicep, /ProjectAcrPull/);
  assert.doesNotMatch(bicep, /principalId: agentComputeIdentity/);
});

test("prepares generated container components as source-backed azd services", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-resource-component-"));
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

test("prepares hosted agents with the azd Foundry agent target", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-hosted-agent-"));
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

test("validates hosted agent manifests and active versions", () => {
  const manifest = createHostedAgentManifest({
    service: "agent",
    sourceDirectory: "/workspace/agent",
    name: "support-agent",
    environment: {},
  });
  assert.equal((manifest.services as any).agent.name, "support-agent");
  assert.deepEqual(
    parseHostedAgentVersion(
      JSON.stringify({ name: "support-agent", version: "2", status: "active" }),
    ),
    { name: "support-agent", version: "2", status: "active" },
  );
  assert.throws(() => parseHostedAgentVersion("{}"), /invalid agent version/);
});

test("isolates Teams state and rejects unresolved workflow placeholders", async () => {
  assert.equal(teamsEnvironmentName("dev"), "deploy-js-dev");
  assert.equal(teamsEnvironmentName("Feature/One"), "deploy-js-feature-one");

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

test("identifies the authorization tenant when Teams consent is required", async () => {
  const previousSubscription = process.env.AZURE_SUBSCRIPTION_ID;
  const previousResourceGroup = process.env.AZURE_RESOURCE_GROUP;
  const previousTenant = process.env.AZURE_TENANT_ID;
  process.env.AZURE_SUBSCRIPTION_ID = "subscription";
  process.env.AZURE_RESOURCE_GROUP = "resources";
  process.env.AZURE_TENANT_ID = "azure-tenant";
  const deployment = {
    deploy: async (_name: string, action: () => Promise<void>) => action(),
    capture: async () => "Error\n",
  } as unknown as Deployment;
  try {
    await assert.rejects(
      enableWorkflowDeployment(deployment, {
        component: "logic-app",
        workflowId: "autoReplyWorkflow",
        workflowName: "auto-reply",
        connectionName: "teams",
        authorizationTenantId: "teams-tenant",
      }),
      /authorize the connection with an account from tenant 'teams-tenant'/,
    );
  } finally {
    restoreEnvironment("AZURE_SUBSCRIPTION_ID", previousSubscription);
    restoreEnvironment("AZURE_RESOURCE_GROUP", previousResourceGroup);
    restoreEnvironment("AZURE_TENANT_ID", previousTenant);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}