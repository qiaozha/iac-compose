import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const contosoRoot = resolve("examples/contoso");

test("Contoso generation emits provisioning code instead of copied contracts", async () => {
  const files = await collectTypeScriptFiles(contosoRoot);
  const source = (
    await Promise.all(files.map((file) => readFile(file, "utf8")))
  ).join("\n");
  const provisioning = await readFile(
    resolve(contosoRoot, "components/shared/provisioning.ts"),
    "utf8",
  );

  assert.match(provisioning, /new Stack\(/);
  assert.match(provisioning, /new Account\(/);
  assert.match(source, /new DatabaseAccount\(/);
  assert.match(source, /new Site\(/);
  assert.match(source, /new Workflow\(/);
  assert.match(source, /deployHostedAgentService/);
  assert.match(source, /deployAppServiceContainer/);
  assert.doesNotMatch(source, /renderResourceRequirements/);
  assert.doesNotMatch(
    source,
    /"schemaVersion"|"requiredBy"|"produces"|const resources\s*=/,
  );
});

test("Contoso components provision their owned resources", async () => {
  const [
    shared,
    sharedLifecycle,
    agent,
    backend,
    frontend,
    logicApp,
    agentLifecycle,
    backendLifecycle,
    frontendLifecycle,
    logicAppLifecycle,
  ] = await Promise.all([
      readFile(
        resolve(contosoRoot, "components/shared/provisioning.ts"),
        "utf8",
      ),
      readFile(resolve(contosoRoot, "components/shared/index.ts"), "utf8"),
      readFile(
        resolve(contosoRoot, "components/agent/provisioning.ts"),
        "utf8",
      ),
      readFile(
        resolve(contosoRoot, "components/backend/provisioning.ts"),
        "utf8",
      ),
      readFile(
        resolve(contosoRoot, "components/frontend/provisioning.ts"),
        "utf8",
      ),
      readFile(
        resolve(contosoRoot, "components/logic-app/provisioning.ts"),
        "utf8",
      ),
      readFile(resolve(contosoRoot, "components/agent/index.ts"), "utf8"),
      readFile(resolve(contosoRoot, "components/backend/index.ts"), "utf8"),
      readFile(resolve(contosoRoot, "components/frontend/index.ts"), "utf8"),
      readFile(resolve(contosoRoot, "components/logic-app/index.ts"), "utf8"),
    ]);

  assert.match(shared, /new Account\(/);
  assert.match(shared, /new ConfigurationStore\(/);
  assert.match(shared, /authenticationMode: "Pass-through"/);
  assert.match(shared, /containerRegistryName/);
  assert.match(shared, /DEPLOY_RESOURCE_CONTAINERREGISTRY_ACCESS_SCOPE/);
  assert.match(
    shared,
    /inputAZURE_AI_LOCATION: fn\.readEnvironmentVariable\("AZURE_AI_LOCATION", "eastus"\)/,
  );
  assert.match(shared, /foundryProjectLocationSuffix/);
  assert.match(shared, /TEAMS_SERVICE_URL_BASE/);
  assert.match(shared, /https:\/\/smba\.trafficmanager\.net\/apac/);
  assert.doesNotMatch(shared, /new ModelDeployment\(/);
  assert.doesNotMatch(shared, /new DatabaseAccount\(|new Site\(|new Workflow\(/);
  assert.match(sharedLifecycle, /grant deployment data-plane roles/);
  for (const roleDefinitionId of [
    "5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b",
    "8311e382-0749-4cb8-b61a-304f252e45ec",
    "64702f94-c441-49e6-a78b-ef80e0188fee",
  ]) {
    assert.match(sharedLifecycle, new RegExp(roleDefinitionId));
  }

  assert.match(agent, /new ModelDeployment\(/);
  assert.match(agent, /foundryModelDeploymentName/);
  assert.match(agent, /name: "gpt-5\.4",\n      version: "2026-03-05"/);
  assert.match(
    agentLifecycle,
    /const infrastructureLocation = process\.env\.AZURE_AI_LOCATION\?\.trim\(\) \|\| "eastus"/,
  );
  assert.match(
    agentLifecycle,
    /parameters: \{ location: infrastructureLocation \}/,
  );
  assert.match(
    agentLifecycle,
    /delete persistedInfrastructureOutputs\.AZURE_LOCATION/,
  );

  assert.match(backend, /new DatabaseAccount\(/);
  assert.match(backend, /new StorageAccount\(/);
  assert.match(backend, /allowSharedKeyAccess: false/);
  assert.match(
    backend,
    /serviceManagementReference: "c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4"/,
  );
  assert.doesNotMatch(backend, /SERVICE_MANAGEMENT_REFERENCE/);
  assert.match(
    backend,
    /\{ name: "AZURE_CLIENT_ID", value: backendComputeIdentity\.properties\.clientId as any \}/,
  );
  assert.match(backend, /new Site\(/);
  assert.match(backend, /backendIdentityResourceId/);
  assert.doesNotMatch(backend, /new Bot\(|new Workflow\(/);

  assert.match(frontend, /new Site\(/);
  assert.match(frontend, /new Bot\(/);
  assert.match(
    frontendLifecycle,
    /componentDirectory: resolve\(packageRoot, "components\/frontend"\)/,
  );
  assert.doesNotMatch(frontendLifecycle, /generatedDirectory:.*teams-app/);
  assert.match(frontend, /contoso-support-frontendcomput-p-/);
  assert.doesNotMatch(
    frontend,
    /const frontendComputePlan = new AppServicePlan\(stack, \{\n  name: fn\.concat\("contoso-support-frontendcompute-", suffix\),/,
  );
  assert.doesNotMatch(frontend, /new DatabaseAccount\(|new Workflow\(/);

  assert.match(logicApp, /new ApiConnection\(/);
  assert.match(logicApp, /new Workflow\(/);
  assert.match(logicApp, /type: "UserAssigned"/);
  assert.match(logicApp, /inputBackendIdentityResourceId/);
  assert.match(logicApp, /inputBotIdentityResourceId/);
  assert.match(logicApp, /https:\/\/api\.botframework\.com/);
  assert.match(logicApp, /af71663c-8492-4c4a-9ac4-a3dbaa71fa7b/);
  assert.match(
    logicApp,
    /19:qeaZlwXJ0W5frHHt7IfeHDzNkS8O512OOBejQG0X7nw1@thread\.tacv2/,
  );
  assert.match(logicAppLifecycle, /authorizationTenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47"/);
  assert.doesNotMatch(logicApp, /<teams-(?:group|channel)-id>/);
  assert.doesNotMatch(logicApp, /autoReplyIdentityPrincipalId/);
  assert.doesNotMatch(logicApp, /new Site\(|new DatabaseAccount\(/);

  const agentProvision = agentLifecycle.indexOf("deployment.provision(");
  const agentDeploy = agentLifecycle.indexOf("deployHostedAgentService(");
  assert.ok(agentProvision >= 0 && agentDeploy > agentProvision);
  for (const lifecycle of [backendLifecycle, frontendLifecycle]) {
    const provision = lifecycle.indexOf("deployment.provision(");
    const deploy = lifecycle.indexOf("deployAppServiceContainer(");
    assert.ok(provision >= 0 && deploy > provision);
  }
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}