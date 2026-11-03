import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeployment, type ProvisionOptions } from "iac-composer";
import deploy from "../examples/foundry/deploy.js";
import { outputBicep } from "../examples/foundry/infra.js";

const outputs = {
  AZURE_AI_ACCOUNT_ID: "/subscriptions/test/resourceGroups/cs336/providers/Microsoft.CognitiveServices/accounts/test",
  AZURE_AI_ACCOUNT_NAME: "test",
  AZURE_AI_PROJECT_ID: "/subscriptions/test/resourceGroups/cs336/providers/Microsoft.CognitiveServices/accounts/test/projects/cs336-project",
  AZURE_AI_PROJECT_NAME: "cs336-project",
  AZURE_AI_PROJECT_ENDPOINT: "https://test.services.ai.azure.com/api/projects/cs336-project",
  AZURE_AI_MODEL_DEPLOYMENT_ID: "/subscriptions/test/resourceGroups/cs336/providers/Microsoft.CognitiveServices/accounts/test/deployments/deepseek-v4-1-flash",
  AZURE_AI_MODEL_DEPLOYMENT_NAME: "deepseek-v4-1-flash",
  AZURE_FOUNDRY_ROLE_ASSIGNMENT_ID: "/subscriptions/test/resourceGroups/cs336/providers/Microsoft.CognitiveServices/accounts/test/providers/Microsoft.Authorization/roleAssignments/test",
  AZURE_FOUNDRY_PRINCIPAL_ID: "e0f63e9f-e67d-46b9-a50d-c5846cc99ed2",
};

test("Foundry emits an Entra-authenticated account, project, model, and deployer role", () => {
  const main = outputBicep.find((file) => file.path === "main.bicep");
  const parameters = outputBicep.find((file) => file.path === "main.bicepparam");
  assert.ok(main?.contents.trim());
  assert.ok(parameters?.contents.trim());
  assert.match(main.contents, /targetScope = 'resourceGroup'/);
  assert.equal((main.contents.match(/^resource /gm) ?? []).length, 4);
  assert.match(main.contents, /Microsoft\.CognitiveServices\/accounts@/);
  assert.match(main.contents, /Microsoft\.CognitiveServices\/accounts\/projects@/);
  assert.match(main.contents, /parent: account/);
  assert.match(main.contents, /kind: 'AIServices'/);
  assert.match(main.contents, /name: 'S0'/);
  assert.match(main.contents, /allowProjectManagement: true/);
  assert.match(main.contents, /disableLocalAuth: true/);
  assert.match(main.contents, /publicNetworkAccess: 'Enabled'/);
  assert.equal((main.contents.match(/type: 'SystemAssigned'/g) ?? []).length, 2);
  assert.match(main.contents, /uniqueString\(resourceGroup\(\)\.id\)/);
  assert.match(main.contents, /project\.properties\.endpoints\['AI Foundry API'\]/);
  assert.doesNotMatch(main.contents, /listKeys|capabilityHosts/);
  for (const name of Object.keys(outputs)) {
    assert.match(main.contents, new RegExp(`output ${name} string`));
  }
  assert.match(parameters.contents, /param location = readEnvironmentVariable\('AZURE_AI_LOCATION'\)/);
});

test("Foundry grants Project Manager to the azd deployer at account scope", () => {
  const main = outputBicep.find((file) => file.path === "main.bicep");
  const parameters = outputBicep.find((file) => file.path === "main.bicepparam");
  assert.ok(main);
  assert.ok(parameters);
  const role = main.contents.match(
    /resource \w+ 'Microsoft\.Authorization\/roleAssignments@[^']+' = \{[\s\S]*?^\}/m,
  )?.[0];
  assert.ok(role);
  assert.match(role, /scope: account/);
  assert.match(role, /name: guid\(account\.id, deploymentPrincipalId, foundryProjectManagerRoleDefinitionId\)/);
  assert.match(role, /roleDefinitionId: foundryProjectManagerRoleDefinitionId/);
  assert.match(role, /principalId: deploymentPrincipalId/);
  assert.match(role, /principalType: deploymentPrincipalType/);
  assert.match(main.contents, /subscriptionResourceId\('Microsoft\.Authorization\/roleDefinitions', 'eadc314b-1a2d-4efa-be10-5d325db5065e'\)/);
  assert.match(main.contents, /param deploymentPrincipalId string/);
  assert.match(main.contents, /param deploymentPrincipalType string/);
  assert.doesNotMatch(main.contents, /param deploymentPrincipal(?:Id|Type) string =/);
  assert.doesNotMatch(main.contents, /e0f63e9f-e67d-46b9-a50d-c5846cc99ed2/);
  assert.match(parameters.contents, /param deploymentPrincipalId = readEnvironmentVariable\('AZURE_PRINCIPAL_ID'\)/);
  assert.match(parameters.contents, /param deploymentPrincipalType = readEnvironmentVariable\('AZURE_PRINCIPAL_TYPE'\)/);
  assert.doesNotMatch(role, /identity\.principalId|scope: resourceGroup/);
});

test("Foundry pins the exact DeepSeek V4.1 model with 50,000 TPM on the account", () => {
  const main = outputBicep.find((file) => file.path === "main.bicep");
  assert.ok(main);
  const model = main.contents.match(
    /resource \w+ 'Microsoft\.CognitiveServices\/accounts\/deployments@[^']+' = \{[\s\S]*?^\}/m,
  )?.[0];
  assert.ok(model);
  assert.match(model, /parent: account/);
  assert.match(model, /name: 'deepseek-v4-1-flash'/);
  assert.match(model, /name: 'GlobalStandard'/);
  assert.match(model, /capacity: 50\b/);
  assert.match(model, /format: 'DeepSeek'/);
  assert.match(model, /name: 'DeepSeek-V4\.1-Flash'/);
  assert.match(model, /version: '2026-09-10'/);
  assert.match(model, /versionUpgradeOption: 'NoAutoUpgrade'/);
  assert.match(model, /dependsOn:\s*\[\s*project\s*\]/);
  assert.doesNotMatch(model, /parent: project|capacity: 50000\b/);
  assert.match(main.contents, /output AZURE_AI_MODEL_DEPLOYMENT_ID string = \w+\.id/);
  assert.match(main.contents, /output AZURE_AI_MODEL_DEPLOYMENT_NAME string = \w+\.name/);
});

test("Foundry checks the existing group before provisioning the exact selected target", async (t) => {
  const deployment = createDeployment({ environment: "cs336", log: () => {} });
  const steps: string[] = [];
  t.mock.method(deployment, "run", async (_name, command) => {
    steps.push("verify");
    assert.equal(command.command, "az");
    assert.deepEqual(command.args, [
      "group", "show",
      "--subscription", "9dbc8298-39f2-4fca-bbec-e8af850c1bc0",
      "--name", "cs336",
      "--query", "id",
      "--output", "tsv",
    ]);
  });
  t.mock.method(deployment, "capture", async (command) => {
    steps.push("principal-type");
    assert.equal(command.command, "az");
    assert.deepEqual(command.args, [
      "account", "show",
      "--subscription", "9dbc8298-39f2-4fca-bbec-e8af850c1bc0",
      "--query", "user.type",
      "--output", "tsv",
    ]);
    return "user\n";
  });
  t.mock.method(deployment, "provision", async (_name, options: ProvisionOptions) => {
    steps.push("provision");
    assert.equal(options.scope, "resourceGroup");
    assert.equal(options.subscription, "9dbc8298-39f2-4fca-bbec-e8af850c1bc0");
    assert.equal(options.resourceGroup, "cs336");
    assert.equal(options.location, "westus2");
    assert.deepEqual(options.parameters, { location: "westus2" });
    assert.deepEqual(options.environmentValues, { AZURE_PRINCIPAL_TYPE: "User" });
    assert.equal(options.deploymentName, "cs336-foundry");
    assert.ok(options.layer?.entrypoint.endsWith("/examples/foundry/infra.ts"));
    assert.ok(options.layer?.outputDirectory.endsWith("/examples/foundry/.generated/foundry"));
    return outputs;
  });
  t.mock.method(deployment, "env", async (_name, values) => {
    steps.push("publish");
    assert.deepEqual(values, outputs);
  });
  await deploy(deployment);
  assert.deepEqual(steps, ["verify", "principal-type", "provision", "publish"]);
});

test("Foundry resolves service principal types without assuming a user", async (t) => {
  const deployment = createDeployment({ log: () => {} });
  t.mock.method(deployment, "run", async () => {});
  t.mock.method(deployment, "capture", async () => "servicePrincipal\n");
  t.mock.method(deployment, "provision", async (_name, options: ProvisionOptions) => {
    assert.deepEqual(options.environmentValues, { AZURE_PRINCIPAL_TYPE: "ServicePrincipal" });
    return outputs;
  });
  t.mock.method(deployment, "env", async () => {});
  await deploy(deployment);
});

test("Foundry rejects missing or unsupported deployment identity types before provisioning", async (t) => {
  for (const accountType of ["", "group"]) {
    const deployment = createDeployment({ log: () => {} });
    t.mock.method(deployment, "run", async () => {});
    t.mock.method(deployment, "capture", async () => accountType);
    const provision = t.mock.method(deployment, "provision", async () => outputs);
    await assert.rejects(deploy(deployment), /Unsupported deployment identity type/);
    assert.equal(provision.mock.callCount(), 0);
  }
});

test("Foundry stops before provisioning when resource-group verification fails", async (t) => {
  const deployment = createDeployment({ log: () => {} });
  t.mock.method(deployment, "run", async () => {
    throw new Error("Subscription not found");
  });
  const provision = t.mock.method(deployment, "provision", async () => outputs);
  await assert.rejects(deploy(deployment), /Subscription not found/);
  assert.equal(provision.mock.callCount(), 0);
});

test("Foundry rejects unknown components, including inherited object keys", async (t) => {
  for (const component of ["unknown", "toString"]) {
    const deployment = createDeployment({ component, log: () => {} });
    const run = t.mock.method(deployment, "run", async () => {});
    const provision = t.mock.method(deployment, "provision", async () => outputs);
    await assert.rejects(deploy(deployment), /Expected: foundry/);
    assert.equal(run.mock.callCount(), 0);
    assert.equal(provision.mock.callCount(), 0);
  }
});

test("Foundry rejects missing or empty required outputs before publishing", async (t) => {
  for (const name of Object.keys(outputs)) {
    for (const value of [undefined, " "]) {
      const deployment = createDeployment({ log: () => {} });
      t.mock.method(deployment, "run", async () => {});
      t.mock.method(deployment, "capture", async () => "user");
      t.mock.method(deployment, "provision", async () => {
        const incomplete: Record<string, string> = { ...outputs };
        if (value === undefined) delete incomplete[name];
        else incomplete[name] = value;
        return incomplete;
      });
      const publish = t.mock.method(deployment, "env", async () => {});
      await assert.rejects(deploy(deployment), new RegExp(`required output '${name}'`));
      assert.equal(publish.mock.callCount(), 0);
    }
  }
});

test("Foundry dry run accepts absent cloud outputs and the foundry component selector", async (t) => {
  const deployment = createDeployment({
    component: "foundry",
    dryRun: true,
    log: () => {},
  });
  t.mock.method(deployment, "run", async () => {});
  const capture = t.mock.method(deployment, "capture", async () => {
    throw new Error("Dry runs must not resolve identity through Azure CLI.");
  });
  const provision = t.mock.method(deployment, "provision", async () => ({}));
  t.mock.method(deployment, "env", async () => {});
  await deploy(deployment);
  assert.equal(provision.mock.callCount(), 1);
  assert.equal(capture.mock.callCount(), 0);
});
