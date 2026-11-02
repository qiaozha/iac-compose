import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeployment, Deployment, type Command } from "iac-composer";
import {
  appConfigurationKeySetArgs,
  createHostedAgentManifest,
  enableWorkflowDeployment,
  parseHostedAgentVersion,
  prepareAuthorizedConnection,
  validateWorkflowParameters,
} from "../src/runtime/services/index.js";

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

test("direct workflow validation rejects placeholders without resource contracts", async () => {
  const parameters = {
    parameters: { teamsGroupId: { value: "<teams-group-id>" } },
  };
  assert.throws(
    () => validateWorkflowParameters("workflow", parameters),
    /cannot be enabled.*parameters\.parameters\.teamsGroupId\.value.*teams-group-id/,
  );
  assert.doesNotThrow(() =>
    validateWorkflowParameters("workflow", { groups: ["actual-group-id"] }),
  );
  await assert.rejects(
    enableWorkflowDeployment(createDeployment({ log: () => {} }), {
      component: "logic-app",
      workflowId: "workflow",
      workflowName: "auto-reply",
      validationValues: parameters,
    }),
    /cannot be enabled.*teams-group-id/,
  );
});

test("direct connection preparation preserves an authorized connection", async () => {
  const previousSubscription = process.env.AZURE_SUBSCRIPTION_ID;
  const previousResourceGroup = process.env.AZURE_RESOURCE_GROUP;
  const previousCreate = process.env.DEPLOY_CREATE_RESOURCE_TEAMSCONNECTION;
  process.env.AZURE_SUBSCRIPTION_ID = "subscription";
  process.env.AZURE_RESOURCE_GROUP = "resources";
  let args: readonly string[] = [];
  class ConnectionDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      args = command.args ?? [];
      return "Connected\n";
    }
  }
  try {
    const status = await prepareAuthorizedConnection(new ConnectionDeployment(), {
      resourceId: "teamsConnection",
      name: "teams",
    });
    assert.equal(status, "Connected");
    assert.equal(process.env.DEPLOY_CREATE_RESOURCE_TEAMSCONNECTION, "false");
    assert.deepEqual(
      args.slice(args.indexOf("--name"), args.indexOf("--name") + 2),
      ["--name", "teams"],
    );
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