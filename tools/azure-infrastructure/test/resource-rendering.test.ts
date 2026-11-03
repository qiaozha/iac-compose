import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOutputBindings } from "../src/runtime/resources/values.js";
import { renderResourceRequirements } from "../src/generation/resources/index.js";
import { validateResourceContract } from "../src/shared/contracts/resources/validation.js";

test("accepts every documented generated resource kind", () => {
  assert.doesNotThrow(() =>
    validateResourceContract({
      schemaVersion: "1.0",
      solution: { name: "catalog-example", enabledComponents: ["app"] },
      resources: [
        { id: "registry", kind: "container-registry", requiredBy: ["app"] },
        { id: "model", kind: "model-deployment", requiredBy: ["app"] },
      ],
    }),
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
