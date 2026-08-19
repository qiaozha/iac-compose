import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  generateDeploymentCode,
  type DeploymentCodeGenerationProgress,
} from "../src/generator.js";
import {
  provisioningDependencies,
  renderEntraIdentityConfigurationSource,
  renderProvisioningSource,
} from "../src/provisioning-source.js";

const execFileAsync = promisify(execFile);

test("generates chatbot-style deployment code in dependency order", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-generator-"));
  const resourcesFile = join(root, "config/generated/resource-requirements.json");
  const solutionFile = join(root, "solution.json");
  const outputDirectory = join(root, "deployment");
  await mkdir(join(root, "config/generated"), { recursive: true });
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: {
        name: "support",
        enabledComponents: ["frontend", "backend"],
      },
      resources: [
        {
          id: "monitoring",
          kind: "application-monitoring",
          requiredBy: ["backend", "frontend"],
          produces: ["applicationInsightsConnectionString"],
        },
        {
          id: "frontendCompute",
          kind: "container-host",
          requiredBy: ["frontend"],
          source: "components/frontend",
          containerPort: 3978,
          configuration: {
            ingress: { allowedServiceTags: ["AzureBotService"] },
            runtimeSettings: {
              BACKEND_BASE_URL: "${output.backendBaseUrl}",
              APPLICATIONINSIGHTS_CONNECTION_STRING:
                "${output.applicationInsightsConnectionString}",
            },
          },
          produces: ["frontendBaseUrl"],
        },
        {
          id: "backendCompute",
          kind: "container-host",
          requiredBy: ["backend"],
          source: "components/backend",
          containerPort: 8080,
          configuration: {
            runtimeSettings: {
              APPLICATIONINSIGHTS_CONNECTION_STRING:
                "${output.applicationInsightsConnectionString}",
            },
          },
          produces: ["backendBaseUrl"],
        },
      ],
      outputBindings: { syntax: "${output.<name>}" },
    }),
  );
  await writeFile(
    solutionFile,
    JSON.stringify({
      schemaVersion: "1.0",
      customer: { name: "support", displayName: "Support" },
      components: [
        { id: "frontend", source: "components/frontend" },
        { id: "backend", source: "components/backend" },
      ],
      resources: {
        contract: "config/generated/resource-requirements.json",
        planned: [
          { id: "monitoring", kind: "application-monitoring" },
          { id: "frontendCompute", kind: "container-host" },
          { id: "backendCompute", kind: "container-host" },
        ],
      },
    }),
  );

  const progress: DeploymentCodeGenerationProgress[] = [];
  const result = await generateDeploymentCode({
    resourcesFile,
    solutionFile,
    outputDirectory,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(result.components, ["shared", "backend", "frontend"]);
  assert.deepEqual(
    progress.map(({ stage, percent }) => ({ stage, percent })),
    [
      { stage: "loadingInputs", percent: 5 },
      { stage: "validatingContracts", percent: 20 },
      { stage: "planningComponents", percent: 35 },
      { stage: "renderingSources", percent: 50 },
      { stage: "writingFiles", percent: 90 },
      { stage: "completed", percent: 100 },
    ],
  );
  assert.equal(progress.at(-1)?.componentCount, 2);
  assert.equal(progress.at(-1)?.fileCount, result.files.length);
  assert.equal(progress.at(-1)?.outputDirectory, outputDirectory);
  const deployment = await readFile(join(outputDirectory, "deploy.ts"), "utf8");
  const backendPosition = deployment.indexOf("await backend(deployment)");
  const frontendPosition = deployment.indexOf("await frontend(deployment)");
  assert.ok(backendPosition >= 0 && frontendPosition > backendPosition);
  const provisioning = await readFile(
    join(outputDirectory, "components/shared/provisioning.ts"),
    "utf8",
  );
  const sharedLifecycle = await readFile(
    join(outputDirectory, "components/shared/index.ts"),
    "utf8",
  );
  const backendProvisioning = await readFile(
    join(outputDirectory, "components/backend/provisioning.ts"),
    "utf8",
  );
  const backend = await readFile(
    join(outputDirectory, "components/backend/index.ts"),
    "utf8",
  );
  assert.match(provisioning, /new Stack\(/);
  assert.match(provisioning, /new Workspace\(/);
  assert.match(provisioning, /new ApplicationInsightsComponent\(/);
  assert.match(provisioning, /applicationInsightsConnectionString/);
  assert.doesNotMatch(
    provisioning,
    /Microsoft\.CognitiveServices\/accounts\/projects\/connections/,
  );
  assert.doesNotMatch(provisioning, /new Site\(/);
  assert.match(backendProvisioning, /new Site\(/);
  assert.match(backendProvisioning, /publicNetworkAccess: "Enabled"/);
  assert.match(provisioning, /renderBicepFiles/);
  assert.doesNotMatch(provisioning, /renderResourceRequirements/);
  assert.doesNotMatch(provisioning, /"schemaVersion"|"requiredBy"|"produces"/);
  assert.match(sharedLifecycle, /grant deployment data-plane roles/);
  assert.match(sharedLifecycle, /8311e382-0749-4cb8-b61a-304f252e45ec/);
  assert.ok(
    sharedLifecycle.indexOf("ensure deployment resource group") <
      sharedLifecycle.indexOf("grant deployment data-plane roles"),
  );

  const frontend = await readFile(
    join(outputDirectory, "components/frontend/index.ts"),
    "utf8",
  );
  assert.match(frontend, /components\/frontend/);
  assert.match(frontend, /deployAppServiceContainer/);
  assert.match(frontend, /defaultAction: "Deny"/);
  assert.doesNotMatch(frontend, /const resources\s*=|"requiredBy"|"produces"/);
  assert.match(backend, /APPLICATIONINSIGHTS_CONNECTION_STRING/);
  assert.match(
    backend,
    /deploymentValue\(deployment, "applicationInsightsConnectionString"\)/,
  );
  assert.match(backend, /defaultAction: "Allow"/);
});

test("limits generated Azure Bot names to 42 characters", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-bot-name-"));
  const resourcesFile = join(root, "resource-requirements.json");
  const solutionFile = join(root, "solution.json");
  const outputDirectory = join(root, "deployment");
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: {
        name: "azure-sdk-engineering-assistant",
        enabledComponents: ["frontend"],
      },
      resources: [
        {
          id: "frontendCompute",
          kind: "container-host",
          requiredBy: ["frontend"],
          source: "components/frontend",
          produces: ["frontendBaseUrl"],
        },
        {
          id: "botIdentity",
          kind: "bot-identity",
          requiredBy: ["frontend"],
          produces: ["botClientId", "botIdentityResourceId", "tenantId"],
        },
      ],
    }),
  );
  await writeFile(
    solutionFile,
    JSON.stringify({
      schemaVersion: "1.0",
      components: [
        { id: "frontend", kind: "http-api", source: "components/frontend" },
      ],
    }),
  );

  await generateDeploymentCode({
    resourcesFile,
    solutionFile,
    outputDirectory,
  });

  const provisioning = await readFile(
    join(outputDirectory, "components/frontend/provisioning.ts"),
    "utf8",
  );
  const match = provisioning.match(
    /const botIdentityBot = new Bot\(stack, \{\s+name: fn\.concat\("([^"]+)", suffix\)/,
  );
  assert.ok(match);
  assert.ok(`${match[1]}abcdef`.length <= 42);
});

test("generate provisions the current Microsoft Entra authentication contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-service-tree-"));
  const resourcesFile = join(root, "resource-requirements.json");
  const solutionFile = join(root, "solution.json");
  const outputDirectory = join(root, "deployment");
  const environmentFile = join(outputDirectory, "environments/dev.json");
  await mkdir(join(outputDirectory, "environments"), { recursive: true });
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["backend"] },
      resources: [
        {
          id: "backendCompute",
          kind: "container-host",
          requiredBy: ["backend"],
          source: "components/backend",
          authentication: "microsoft-entra",
          configuration: {
            authentication: {
              provider: "microsoft-entra",
              delegatedPermissionScope: "token",
              authorizedClientApplicationIds: [
                "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
              ],
            },
          },
          produces: ["backendBaseUrl"],
        },
      ],
    }),
  );
  await writeFile(
    solutionFile,
    JSON.stringify({
      schemaVersion: "1.0",
      components: [
        { id: "backend", kind: "http-api", source: "components/backend" },
      ],
    }),
  );
  await writeFile(
    environmentFile,
    `${JSON.stringify({ EXISTING_VALUE: "preserved" }, null, 2)}\n`,
  );

  await generateDeploymentCode({
    resourcesFile,
    solutionFile,
    outputDirectory,
  });

  assert.deepEqual(JSON.parse(await readFile(environmentFile, "utf8")), {
    EXISTING_VALUE: "preserved",
  });
  const provisioning = await readFile(
    join(outputDirectory, "components/backend/provisioning.ts"),
    "utf8",
  );
  const identityBootstrap = await readFile(
    join(outputDirectory, "components/shared/identity-bootstrap.ts"),
    "utf8",
  );
  const identityConfiguration = await readFile(
    join(outputDirectory, "components/shared/identity-configuration.ts"),
    "utf8",
  );
  const identityLifecycle = await readFile(
    join(outputDirectory, "components/shared/identity.ts"),
    "utf8",
  );
  assert.match(
    identityBootstrap,
    /serviceManagementReference: "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4"/,
  );
  assert.match(identityConfiguration, /oauth2PermissionScopes/);
  assert.match(identityConfiguration, /value: "token"/);
  assert.match(identityConfiguration, /preAuthorizedApplications/);
  assert.match(identityConfiguration, /value: "access_as_application"/);
  assert.match(
    identityConfiguration,
    /appId: "04b07795-8ddb-461a-bbee-02f9e1bf7b46"/,
  );
  assert.match(identityConfiguration, /ExistingPermissionScopes/);
  assert.match(identityConfiguration, /ExistingApplicationRoles/);
  assert.match(identityLifecycle, /server application permissions/);
  assert.match(identityLifecycle, /server application pre-authorization/);
  assert.match(provisioning, /backendComputeAudience/);
  assert.doesNotMatch(provisioning, /Microsoft\.Graph|allowedApplications/);
});

test("authorizes peer identities and generates private App Service networking", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-peer-auth-"));
  const resourcesFile = join(root, "resource-requirements.json");
  const solutionFile = join(root, "solution.json");
  const outputDirectory = join(root, "deployment");
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["backend", "frontend"] },
      resources: [
        {
          id: "backendCompute",
          kind: "container-host",
          requiredBy: ["backend"],
          source: "components/backend",
          authentication: "microsoft-entra",
          configuration: {
            ingress: {
              mode: "restricted",
              privateEndpoint: {
                sourceResources: ["frontendCompute"],
              },
            },
            authentication: {
              provider: "microsoft-entra",
              delegatedPermissionScope: "token",
              authorizedClientApplicationIds: ["existing-client-id"],
              callerApplicationIds: ["platform-client-id"],
              authorizeDeploymentPrincipal: true,
            },
          },
          produces: ["backendBaseUrl"],
        },
        {
          id: "frontendCompute",
          kind: "container-host",
          requiredBy: ["frontend"],
          source: "components/frontend",
          produces: [
            "frontendBaseUrl",
            "frontendIdentityPrincipalId",
            "frontendIdentityResourceId",
          ],
        },
      ],
    }),
  );
  await writeFile(
    solutionFile,
    JSON.stringify({
      schemaVersion: "1.0",
      components: [
        { id: "frontend", kind: "http-api", source: "components/frontend" },
        { id: "backend", kind: "http-api", source: "components/backend" },
      ],
    }),
  );

  const result = await generateDeploymentCode({
    resourcesFile,
    solutionFile,
    outputDirectory,
  });

  assert.deepEqual(result.components, ["shared", "backend", "frontend"]);
  const frontend = await readFile(
    join(outputDirectory, "components/frontend/index.ts"),
    "utf8",
  );
  const backendProvisioning = await readFile(
    join(outputDirectory, "components/backend/provisioning.ts"),
    "utf8",
  );
  const identityConfiguration = await readFile(
    join(outputDirectory, "components/shared/identity-configuration.ts"),
    "utf8",
  );
  const identityLifecycle = await readFile(
    join(outputDirectory, "components/shared/identity.ts"),
    "utf8",
  );
  assert.match(frontend, /ensureAppServicePrivateEndpoint/);
  assert.doesNotMatch(frontend, /ensureAppServicePeerIngress/);
  assert.match(frontend, /location: requiredEnv\("AZURE_LOCATION"\)/);
  assert.match(frontend, /resourceGroup: requiredEnv\("AZURE_RESOURCE_GROUP"\)/);
  assert.match(frontend, /subscription: requiredEnv\("AZURE_SUBSCRIPTION_ID"\)/);
  assert.match(frontend, /targetResourceName: "backendCompute"/);
  assert.match(frontend, /publicNetworkAccess: "Disabled"/);
  assert.doesNotMatch(backendProvisioning, /publicNetworkAccess: "Enabled"/);
  assert.match(frontend, /configureEntraApplications/);
  assert.doesNotMatch(frontend, /ensureAppServicePeerAuthentication/);
  assert.match(identityConfiguration, /Microsoft\.Graph\/appRoleAssignedTo/);
  assert.match(identityConfiguration, /frontendIdentityPrincipalId/);
  assert.match(identityLifecycle, /ensureAppServiceClientAuthorization/);
  assert.match(
    identityLifecycle,
    /siteNameOutput: "DEPLOY_RESOURCE_BACKENDCOMPUTE_NAME"/,
  );
  assert.match(
    identityLifecycle,
    /authorizedClientApplicationIds: \["existing-client-id"\]/,
  );
  assert.match(
    identityLifecycle,
    /callerApplications: \[\{"applicationId":"platform-client-id"/,
  );
  assert.match(identityLifecycle, /"AZURE_PRINCIPAL_ID"/);
  assert.match(identityLifecycle, /Application .* has no service principal/);
  assert.match(identityLifecycle, /"ad",\s+"sp",\s+"show"/);
});

test("authorizes peer identities without private App Service networking", () => {
  const identityConfiguration = renderEntraIdentityConfigurationSource({
    requirements: {
      schemaVersion: "1.0",
      solution: {
        name: "support",
        enabledComponents: ["backend", "frontend"],
      },
      resources: [
        {
          id: "backendCompute",
          kind: "container-host",
          requiredBy: ["backend"],
          authentication: "microsoft-entra",
          configuration: {
            ingress: { mode: "unrestricted" },
            authentication: {
              provider: "microsoft-entra",
              delegatedPermissionScope: "token",
              authorizedClientApplicationIds: [],
              callerResources: ["frontendCompute"],
            },
          },
          produces: ["backendBaseUrl"],
        },
        {
          id: "frontendCompute",
          kind: "container-host",
          requiredBy: ["frontend"],
          produces: [
            "frontendBaseUrl",
            "frontendIdentityPrincipalId",
            "frontendIdentityResourceId",
          ],
        },
      ],
    },
    solution: {
      schemaVersion: "1.0",
      components: [
        { id: "backend" },
        { id: "frontend" },
      ],
    },
    orderedComponents: ["backend", "frontend"],
    templates: {},
    serviceManagementReference: "service-management-reference",
  });

  assert.match(identityConfiguration, /Microsoft\.Graph\/appRoleAssignedTo/);
  assert.match(identityConfiguration, /frontendIdentityPrincipalId/);
});

test("reuses a configured Teams app manifest ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-teams-app-id-"));
  const resourcesFile = join(root, "resource-requirements.json");
  const solutionFile = join(root, "solution.json");
  const outputDirectory = join(root, "deployment");
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["frontend"] },
      resources: [
        {
          id: "frontendCompute",
          kind: "container-host",
          requiredBy: ["frontend"],
          source: "components/frontend",
          produces: ["frontendBaseUrl"],
        },
        {
          id: "teamsApplication",
          kind: "teams-application",
          requiredBy: ["frontend"],
          configuration: {
            existingAppId: "9668bcb5-a50b-4e39-a136-b3301305de66",
            teamId: "af71663c-8492-4c4a-9ac4-a3dbaa71fa7b",
            manifestValues: {
              TEAMS_APP_ID: "9668bcb5-a50b-4e39-a136-b3301305de66",
              BOT_ID: "bot-id",
            },
          },
          produces: ["teamsAppId"],
        },
      ],
    }),
  );
  await writeFile(
    solutionFile,
    JSON.stringify({
      schemaVersion: "1.0",
      components: [
        { id: "frontend", kind: "http-api", source: "components/frontend" },
      ],
    }),
  );

  await generateDeploymentCode({ resourcesFile, solutionFile, outputDirectory });

  const frontend = await readFile(
    join(outputDirectory, "components/frontend/index.ts"),
    "utf8",
  );
  assert.match(
    frontend,
    /existingAppId: "9668bcb5-a50b-4e39-a136-b3301305de66"/,
  );
  assert.match(
    frontend,
    /teamId: "af71663c-8492-4c4a-9ac4-a3dbaa71fa7b"/,
  );
});

test("orders hosted agents before application services", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-hosted-order-"));
  const resourcesFile = join(root, "resource-requirements.json");
  const solutionFile = join(root, "solution.json");
  const outputDirectory = join(root, "deployment");
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["backend", "agent"] },
      resources: [
        {
          id: "agentCompute",
          kind: "container-host",
          requiredBy: ["agent"],
          source: "components/agent",
          produces: ["agentEndpoint", "agentIdentityPrincipalId"],
        },
        {
          id: "backendCompute",
          kind: "container-host",
          requiredBy: ["backend"],
          source: "components/backend",
          produces: ["backendBaseUrl"],
        },
      ],
    }),
  );
  await writeFile(
    solutionFile,
    JSON.stringify({
      schemaVersion: "1.0",
      components: [
        { id: "backend", kind: "http-api", source: "components/backend" },
        { id: "agent", kind: "hosted-agent", source: "components/agent" },
      ],
    }),
  );

  await generateDeploymentCode({ resourcesFile, solutionFile, outputDirectory });

  const deployment = await readFile(join(outputDirectory, "deploy.ts"), "utf8");
  assert.ok(
    deployment.indexOf("await agent(deployment)") <
      deployment.indexOf("await backend(deployment)"),
  );
  assert.match(
    await readFile(join(outputDirectory, "components/agent/index.ts"), "utf8"),
    /deployHostedAgentService/,
  );
});

test("runs generated code outside the package dependency tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-out-of-tree-"));
  const resourcesFile = join(root, "resource-requirements.json");
  const solutionFile = join(root, "solution.json");
  const outputDirectory = join(root, "deployment");
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: { name: "empty", enabledComponents: [] },
      resources: [],
    }),
  );
  await writeFile(
    solutionFile,
    JSON.stringify({ schemaVersion: "1.0", components: [] }),
  );

  const cli = resolve("dist/cli.js");
  await execFileAsync(process.execPath, [
    cli,
    "generate",
    "--resources",
    resourcesFile,
    "--solution",
    solutionFile,
    "--output",
    outputDirectory,
  ]);
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "run",
    join(outputDirectory, "deploy.ts"),
    "--environment",
    "dev",
    "--component",
    "shared",
    "--dry-run",
  ]);

  assert.match(stdout, /DRY provision: solution infrastructure/);

  const tsx = resolve("node_modules/.bin/tsx");
  const sourceRun = await execFileAsync(tsx, [
    resolve("src/cli.ts"),
    "run",
    join(outputDirectory, "deploy.ts"),
    "--environment",
    "dev",
    "--component",
    "shared",
    "--dry-run",
  ]);
  assert.match(sourceRun.stdout, /DRY provision: solution infrastructure/);
});

test("rejects component lifecycle resources that would be dropped", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-multiple-containers-"));
  const resourcesFile = join(root, "resource-requirements.json");
  const solutionFile = join(root, "solution.json");
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["backend"] },
      resources: [
        {
          id: "api",
          kind: "container-host",
          requiredBy: ["backend"],
          source: "components/api",
          produces: ["backendBaseUrl"],
        },
        {
          id: "worker",
          kind: "container-host",
          requiredBy: ["backend"],
          source: "components/worker",
        },
      ],
    }),
  );
  await writeFile(
    solutionFile,
    JSON.stringify({
      schemaVersion: "1.0",
      components: [
        { id: "backend", kind: "http-api", source: "components/api" },
      ],
    }),
  );

  await assert.rejects(
    generateDeploymentCode({
      resourcesFile,
      solutionFile,
      outputDirectory: join(root, "deployment"),
    }),
    /requires exactly one container-host resource; found 2/,
  );
});

test("gates generated workflows on interactive Teams connection consent", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-teams-connection-"));
  const resourcesFile = join(root, "resource-requirements.json");
  const solutionFile = join(root, "solution.json");
  const outputDirectory = join(root, "deployment");
  const templateDirectory = join(root, "components/logic-app");
  await mkdir(templateDirectory, { recursive: true });
  await writeFile(
    join(templateDirectory, "template.json"),
    JSON.stringify({
      parameters: { teamsGroupId: { type: "string" } },
      resources: [
        {
          properties: {
            definition: {
              parameters: { $connections: { type: "Object", defaultValue: {} } },
              triggers: {
                message: {
                  type: "Request",
                  inputs: { groupId: "[parameters('teamsGroupId')]" },
                },
              },
              actions: {},
              outputs: {},
            },
          },
        },
      ],
    }),
  );
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["logic-app"] },
      resources: [
        {
          id: "teamsConnection",
          kind: "authorized-api-connection",
          requiredBy: ["logic-app"],
          authorization: "interactive",
          configuration: { tenantId: "teams-tenant-id" },
          produces: ["teamsConnectionResourceId"],
        },
        {
          id: "autoReplyWorkflow",
          kind: "workflow-host",
          requiredBy: ["logic-app"],
          source: "components/logic-app/template.json",
          parameters: {
            parameters: { teamsGroupId: { value: "group-id" } },
          },
          produces: ["autoReplyIdentityPrincipalId"],
        },
      ],
    }),
  );
  await writeFile(
    solutionFile,
    JSON.stringify({
      schemaVersion: "1.0",
      components: [{ id: "logic-app", kind: "workflow" }],
    }),
  );

  await generateDeploymentCode({ resourcesFile, solutionFile, outputDirectory });

  const lifecycle = await readFile(
    join(outputDirectory, "components/logic-app/index.ts"),
    "utf8",
  );
  const provisioning = await readFile(
    join(outputDirectory, "components/logic-app/provisioning.ts"),
    "utf8",
  );
  assert.match(
    lifecycle,
    /const connectionStatus = await prepareAuthorizedConnection/,
  );
  assert.match(
    lifecycle,
    /authorizationTenantId: "teams-tenant-id"/,
  );
  assert.match(
    lifecycle,
    /process\.env\["DEPLOY_WORKFLOW_AUTOREPLYWORKFLOW"\][\s\S]*?deployment\.dryRun \|\| connectionStatus === "Connected"/,
  );
  assert.match(
    provisioning,
    /const deployAutoReplyWorkflow = stack\.parameters\.add\("deployAutoReplyWorkflow", "bool"\)/,
  );
  assert.match(
    provisioning,
    /new Workflow\([\s\S]*?\{ condition: deployAutoReplyWorkflow \},\n\);/,
  );
  assert.match(
    provisioning,
    /autoReplyIdentityPrincipalId[\s\S]*?fn\.cond\([\s\S]*?deployAutoReplyWorkflow/,
  );
  assert.match(
    provisioning,
    /DEPLOY_RESOURCE_AUTOREPLYWORKFLOW_NAME[\s\S]*?autoReplyWorkflowName/,
  );
  assert.doesNotMatch(
    provisioning,
    /DEPLOY_RESOURCE_AUTOREPLYWORKFLOW_NAME[\s\S]*?autoReplyWorkflow\.name/,
  );
});

test("AI-only provisioning does not reference a missing registry", () => {
  const source = renderProvisioningSource({
    requirements: {
      schemaVersion: "1.0",
      solution: { name: "ai-only", enabledComponents: ["agent"] },
      resources: [
        {
          id: "foundryProject",
          kind: "ai-project",
          requiredBy: ["agent"],
          produces: ["foundryProjectEndpoint", "agentName", "agentVersion"],
        },
      ],
    },
    solution: {
      schemaVersion: "1.0",
      components: [{ id: "agent", kind: "resource-only" }],
    },
    orderedComponents: ["agent"],
    templates: {},
    serviceManagementReference: "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4",
  });

  assert.match(source, /new Account\(/);
  assert.doesNotMatch(source, /deploymentRegistry/);
});

test("connects hosted-agent monitoring to its Foundry project", () => {
  const source = renderProvisioningSource({
    requirements: {
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["agent"] },
      resources: [
        {
          id: "foundryProject",
          kind: "ai-project",
          requiredBy: ["agent"],
        },
        {
          id: "monitoring",
          kind: "application-monitoring",
          requiredBy: ["agent"],
          produces: ["applicationInsightsConnectionString"],
        },
      ],
    },
    solution: {
      schemaVersion: "1.0",
      components: [{ id: "agent", kind: "hosted-agent" }],
    },
    orderedComponents: ["agent"],
    templates: {},
    serviceManagementReference: "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4",
  });

  assert.match(source, /import \{ fn, Resource, Stack \}/);
  assert.match(
    source,
    /new Resource\(foundryProjectProject, \{[\s\S]*?type: "Microsoft\.CognitiveServices\/accounts\/projects\/connections"/,
  );
  assert.match(source, /apiVersion: "2025-06-01"/);
  assert.match(source, /category: "AppInsights"/);
  assert.match(source, /target: monitoringInsights\.id/);
  assert.match(source, /authType: "ApiKey"/);
  assert.match(
    source,
    /key: monitoringInsights\.properties\.ConnectionString as any/,
  );
  assert.match(source, /ResourceId: monitoringInsights\.id/);
});

test("renders explicit model, registry, and workflow identity resources", () => {
  const source = renderProvisioningSource({
    requirements: {
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["app"] },
      resources: [
        {
          id: "foundryProject",
          kind: "ai-project",
          requiredBy: ["app"],
        },
        {
          id: "model",
          kind: "model-deployment",
          parent: "foundryProject",
          requiredBy: ["app"],
          configuration: {
            model: "gpt-5.4",
            version: "2026-03-05",
            deploymentName: "chat-model",
          },
          produces: ["foundryModelDeploymentName"],
        },
        {
          id: "registry",
          kind: "container-registry",
          requiredBy: ["app"],
          produces: ["containerRegistryName", "containerRegistryEndpoint"],
          access: [
            {
              principalOutput: "backendIdentityPrincipalId",
              role: "AcrPull",
            },
          ],
        },
        {
          id: "compute",
          kind: "container-host",
          requiredBy: ["app"],
          produces: ["backendBaseUrl", "backendIdentityPrincipalId"],
        },
        {
          id: "workflow",
          kind: "workflow-host",
          requiredBy: ["app"],
          source: "workflow.json",
          produces: ["autoReplyIdentityPrincipalId"],
        },
      ],
    },
    solution: {
      schemaVersion: "1.0",
      components: [{ id: "app", kind: "http-api" }],
    },
    orderedComponents: ["app"],
    templates: {
      workflow: {
        parameters: {},
        resources: [
          {
            properties: {
              definition: { parameters: {}, triggers: {}, actions: {}, outputs: {} },
            },
          },
        ],
      },
    },
    serviceManagementReference: "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4",
  });

  assert.equal(source.match(/new ModelDeployment\(/g)?.length, 1);
  assert.match(
    source,
    /inputAZURE_AI_LOCATION: fn\.readEnvironmentVariable\("AZURE_AI_LOCATION", "eastus"\)/,
  );
  assert.match(
    source,
    /const foundryProjectAccount = new Account\(stack, \{[\s\S]*?location: inputAZURE_AI_LOCATION/,
  );
  assert.match(
    source,
    /fn\.uniqueString\(fn\.resourceGroup\(\)\.id, inputAZURE_AI_LOCATION\)/,
  );
  assert.match(
    source,
    /name: fn\.concat\("support-foundryproject-ai-", foundryProjectLocationSuffix\)/,
  );
  assert.match(
    source,
    /customSubDomainName: fn\.concat\("support-foundryproject-ai-", foundryProjectLocationSuffix\)/,
  );
  assert.match(source, /name: "chat-model"/);
  assert.match(source, /name: "gpt-5\.4",\n      version: "2026-03-05"/);
  assert.match(source, /foundryModelDeploymentName/);
  assert.match(source, /containerRegistryName/);
  assert.match(source, /containerRegistryEndpoint/);
  assert.equal(source.match(/new RoleAssignment\(deploymentRegistry/g)?.length, 2);
    assert.match(source, /\(workflow as any\)\.identity\.principalId as any/);
});

test("generated provisioning dependencies use bundled release assets", async () => {
  const repositoryRoot = resolve(".");
  const outputDirectory = resolve("generated/deployment");
  const dependencies = provisioningDependencies(
    outputDirectory,
    repositoryRoot,
  );
  assert.ok(Object.keys(dependencies).length > 0);
  for (const [name, value] of Object.entries(dependencies)) {
    const packageName = name.slice("@azure/".length);
    assert.equal(
      value,
      `file:../../vendor/azure-${packageName}-0.1.0.tgz`,
      name,
    );
    await access(resolve(outputDirectory, value.slice("file:".length)));
  }

  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.ok(manifest.files.includes("vendor"));
});