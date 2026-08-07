import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { generateDeploymentCode } from "../src/generator.js";
import { renderProvisioningSource } from "../src/provisioning-source.js";

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
          id: "frontendCompute",
          kind: "container-host",
          requiredBy: ["frontend"],
          source: "components/frontend",
          containerPort: 3978,
          configuration: {
            runtimeSettings: {
              BACKEND_BASE_URL: "${output.backendBaseUrl}",
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
          { id: "frontendCompute", kind: "container-host" },
          { id: "backendCompute", kind: "container-host" },
        ],
      },
    }),
  );

  const result = await generateDeploymentCode({
    resourcesFile,
    solutionFile,
    outputDirectory,
  });

  assert.deepEqual(result.components, ["shared", "backend", "frontend"]);
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
  assert.match(provisioning, /new Stack\(/);
  assert.doesNotMatch(provisioning, /new Site\(/);
  assert.match(backendProvisioning, /new Site\(/);
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
  assert.doesNotMatch(frontend, /const resources\s*=|"requiredBy"|"produces"/);
});

test("generate resolves the fixed chatbot Service Tree ID in provisioning", async () => {
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
          authentication: "managed-identity",
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
  assert.match(
    provisioning,
    /serviceManagementReference: "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4"/,
  );
  assert.doesNotMatch(provisioning, /SERVICE_MANAGEMENT_REFERENCE/);
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

test("published package includes provisioning SDK tarballs", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.ok(manifest.files.includes("vendor"));
});