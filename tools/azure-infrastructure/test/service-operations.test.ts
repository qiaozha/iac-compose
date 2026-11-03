import assert from "node:assert/strict";
import { test } from "node:test";
import { Deployment, type Command } from "iac-composer";
import {
  getActiveHostedAgentVersion,
  parseHostedAgentVersion,
} from "../src/runtime/services/hosted-agent.js";
import {
  getApiConnectionStatus,
  requireApiConnectionAuthorization,
} from "../src/runtime/services/api-connections.js";
import { setAppConfigurationKeyValues } from "../src/runtime/services/app-configuration.js";
import { ensureDeploymentPrincipalRoles } from "../src/runtime/services/authorization.js";

class ProviderDeployment extends Deployment {
  readonly captured: Command[] = [];
  readonly executed: Command[] = [];
  response = "";
  failure?: Error;

  override async capture(command: Command): Promise<string> {
    this.captured.push(command);
    if (this.failure) throw this.failure;
    return this.response;
  }

  override async execute(command: Command): Promise<void> {
    this.executed.push(command);
    if (this.failure) throw this.failure;
  }
}

const connection = {
  subscriptionId: "customer-subscription",
  resourceGroup: "customer-resources",
  name: "office-connection",
};

test("Microsoft.Web reads connection state using explicit resource scope", async () => {
  const deployment = new ProviderDeployment();
  deployment.response = "Connected\n";
  assert.equal(await getApiConnectionStatus(deployment, connection), "Connected");
  assert.deepEqual(deployment.captured[0].args, [
    "resource", "show",
    "--subscription", connection.subscriptionId,
    "--resource-group", connection.resourceGroup,
    "--resource-type", "Microsoft.Web/connections",
    "--name", connection.name,
    "--api-version", "2016-06-01",
    "--query", "properties.statuses[0].status",
    "--output", "tsv",
  ]);
  assert.equal(deployment.executed.length, 0);
});

for (const code of ["ResourceNotFound", "ResourceGroupNotFound"]) {
  test(`Microsoft.Web represents an absent resource only for ${code}`, async () => {
    const deployment = new ProviderDeployment();
    deployment.failure = new Error(`az exited with code 3: ERROR: (${code}) Missing.`);
    assert.equal(await getApiConnectionStatus(deployment, connection), undefined);
  });
}

for (const message of ["(AuthorizationFailed) Denied.", "Azure CLI is unavailable.", "HTTP 429"]) {
  test(`Microsoft.Web propagates ${message}`, async () => {
    const deployment = new ProviderDeployment();
    const failure = new Error(message);
    deployment.failure = failure;
    await assert.rejects(getApiConnectionStatus(deployment, connection), failure);
    await assert.rejects(requireApiConnectionAuthorization(deployment, connection), failure);
  });
}

test("Microsoft.Web rejects empty status and provides actionable tenant-aware consent errors", async () => {
  const deployment = new ProviderDeployment();
  await assert.rejects(
    getApiConnectionStatus(deployment, connection),
    /did not return an authorization status/,
  );
  deployment.response = "Error\n";
  await assert.rejects(
    requireApiConnectionAuthorization(deployment, {
      ...connection,
      portalTenantId: "azure-tenant",
      authorizationTenantId: "external-tenant",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /current status: 'Error'/);
      assert.ok(error.message.includes(
        `https://portal.azure.com/#@azure-tenant/resource/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}/providers/Microsoft.Web/connections/${connection.name}/edit`,
      ));
      assert.match(error.message, /authorize the connection with an account from tenant 'external-tenant'/);
      return true;
    },
  );
  deployment.response = "Connected\n";
  await requireApiConnectionAuthorization(deployment, connection);
  assert.equal(deployment.executed.length, 0);
});

test("provider status and configuration helpers perform no calls during dry run", async () => {
  const deployment = new ProviderDeployment({ dryRun: true });
  assert.equal(await getApiConnectionStatus(deployment, connection), undefined);
  await requireApiConnectionAuthorization(deployment, connection);
  await setAppConfigurationKeyValues(deployment, {
    subscriptionId: "subscription",
    storeName: "store",
    values: { FEATURE: "enabled" },
  });
  await ensureDeploymentPrincipalRoles(deployment, {
    subscriptionId: "subscription",
    tenantId: "tenant",
    scope: "/subscriptions/subscription",
    roles: [],
  });
  assert.equal(deployment.captured.length, 0);
  assert.equal(deployment.executed.length, 0);
});

test("Microsoft.CognitiveServices reads active versions and deployment-created identities", async () => {
  let captured: readonly string[] = [];
  const active = await getActiveHostedAgentVersion({
    environment: "production",
    capture: async (args) => {
      captured = args;
      return JSON.stringify({
        name: "customer-agent",
        version: "7",
        status: "active",
        instance_identity: { principal_id: "agent-principal" },
      });
    },
  }, "customer-service");
  assert.deepEqual(captured, [
    "ai", "agent", "show", "customer-service",
    "--environment", "production", "--output", "json", "--no-prompt",
  ]);
  assert.equal(active.instance_identity.principal_id, "agent-principal");
  assert.equal(active.version, "7");
});

test("Microsoft.CognitiveServices fails for invalid output, inactive versions and missing identities", async () => {
  for (const output of [
    "{}",
    "not-json",
    '{"name":"","version":"1","status":"active"}',
    '{"name":"agent","version":"1","status":"active","instance_identity":{"principal_id":42}}',
  ]) {
    assert.throws(() => parseHostedAgentVersion(output));
  }
  const version = { name: "agent", version: "1", status: "active" };
  await assert.rejects(
    getActiveHostedAgentVersion({
      environment: "dev",
      capture: async () => JSON.stringify({ ...version, status: "failed" }),
    }, "agent"),
    /status 'failed'.*expected 'active'/,
  );
  await assert.rejects(
    getActiveHostedAgentVersion({
      environment: "dev",
      capture: async () => JSON.stringify(version),
    }, "agent"),
    /did not return an instance identity/,
  );
  const failure = new Error("Foundry deployment lookup denied");
  await assert.rejects(
    getActiveHostedAgentVersion({
      environment: "dev",
      capture: async () => { throw failure; },
    }, "agent"),
    failure,
  );
});

test("Microsoft.AppConfiguration writes caller-selected non-secret keys in order", async () => {
  const deployment = new ProviderDeployment();
  await setAppConfigurationKeyValues(deployment, {
    subscriptionId: "subscription-id",
    storeName: "customer-store",
    values: { CUSTOM_AGENT_VERSION: "2", FEATURE_ENABLED: "true" },
  });
  assert.deepEqual(deployment.executed[0], {
    command: "az",
    args: [
      "appconfig", "kv", "set",
      "--subscription", "subscription-id",
      "--name", "customer-store",
      "--auth-mode", "login",
      "--key", "CUSTOM_AGENT_VERSION",
      "--value", "2",
      "--yes", "--output", "none",
    ],
  });
  assert.ok(deployment.executed[1].args?.includes("FEATURE_ENABLED"));
  const failure = new Error("App Configuration access denied");
  deployment.failure = failure;
  await assert.rejects(
    setAppConfigurationKeyValues(deployment, {
      subscriptionId: "subscription-id",
      storeName: "customer-store",
      values: { FEATURE_ENABLED: "true" },
    }),
    failure,
  );
});

test("Microsoft.Authorization grants only the caller's requested missing roles and scope", async () => {
  class AuthorizationDeployment extends ProviderDeployment {
    override async capture(command: Command): Promise<string> {
      this.captured.push(command);
      if (command.args?.[0] === "account") return "customer-tenant\n";
      if (command.args?.includes("existing-role")) return "existing-assignment\n";
      return "";
    }
  }
  const deployment = new AuthorizationDeployment();
  const scope = "/subscriptions/customer-subscription/resourceGroups/customer-resources";
  await ensureDeploymentPrincipalRoles(deployment, {
    subscriptionId: "customer-subscription",
    tenantId: "customer-tenant",
    principalId: "customer-principal",
    principalType: "ServicePrincipal",
    scope,
    roles: ["existing-role", "requested-role"].map((id) => ({
      provider: "Microsoft.Storage",
      role: id,
      roleDefinitionId: id,
      reason: "Customer-selected post-provisioning operation",
    })),
  });
  const grants = deployment.executed.filter((command) => command.args?.[0] === "role");
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].args, [
    "role", "assignment", "create",
    "--assignee-object-id", "customer-principal",
    "--assignee-principal-type", "ServicePrincipal",
    "--role", "requested-role",
    "--scope", scope,
    "--output", "none",
  ]);
  assert.ok(deployment.captured
    .filter((command) => command.args?.[0] === "role")
    .every((command) => command.args?.includes("--include-inherited")));
});

test("Microsoft.Authorization propagates permission failures rather than escalating access", async () => {
  const failure = new Error("(AuthorizationFailed) Role assignment write denied.");
  class DeniedDeployment extends ProviderDeployment {
    override async capture(command: Command): Promise<string> {
      return command.args?.[0] === "account" ? "tenant\n" : "";
    }

    override async execute(command: Command): Promise<void> {
      this.executed.push(command);
      if (command.args?.[0] === "role") throw failure;
    }
  }
  const deployment = new DeniedDeployment();
  await assert.rejects(
    ensureDeploymentPrincipalRoles(deployment, {
      subscriptionId: "subscription",
      scope: "/subscriptions/subscription",
      roles: [{
        provider: "Microsoft.Storage",
        role: "requested-role",
        roleDefinitionId: "requested-role",
        reason: "Customer-selected operation",
      }],
    }),
    failure,
  );
  const roleCommands = deployment.executed.filter((command) => command.args?.[0] === "role");
  assert.equal(roleCommands.length, 1);
  assert.ok(roleCommands[0].args?.includes("requested-role"));
});
