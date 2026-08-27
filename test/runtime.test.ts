import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createDeployment,
  Deployment,
  ensureAppServiceClientAuthorization,
  ensureAppServiceContainerPullIdentity,
  ensureAppServiceIngress,
  ensureAppServicePrivateEndpoint,
  ensureAppServicePeerIngress,
  ensureRoleAssignment,
  provisionTeamsApplication,
  waitForAppServiceReady,
  type Command,
} from "../src/index.js";

test("dry run renders provision artifacts without running deployment actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-compose-dry-run-"));
  const entrypoint = join(root, "infra.ts");
  const outputDirectory = join(root, "generated");
  await writeFile(
    entrypoint,
    `export const outputBicep = [
      { path: "main.bicep", contents: "targetScope = 'subscription'\\n" },
      { path: "main.bicepparam", contents: "using './main.bicep'\\n" }
    ];\n`,
  );
  const messages: string[] = [];
  let deploymentRan = false;
  const deployment = createDeployment({
    dryRun: true,
    environment: "dev",
    projectDirectory: root,
    log: (message) => messages.push(message),
  });

  await deployment.env("prepare shared values", { EXAMPLE: "value" });
  await deployment.provision("chatbot resources", {
    entrypoint,
    outputDirectory,
    deploymentName: "dry-run-infra",
  });
  await deployment.deploy("function app", () => {
    deploymentRan = true;
  });
  await deployment.run("patch logic workflow", { command: "tsx", args: ["patch.ts"] });

  assert.equal(deploymentRan, false);
  assert.match(
    await readFile(join(outputDirectory, "main.bicep"), "utf8"),
    /targetScope = 'subscription'/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(outputDirectory, "azure.yaml"), "utf8")),
    {
      name: "dry-run-infra",
      infra: { provider: "bicep", path: ".", module: "main" },
    },
  );
  assert.deepEqual(messages, [
    "[iac-compose] DRY env: prepare shared values",
    "[iac-compose] DRY provision: chatbot resources",
    "[iac-compose] $ azd provision --environment dev --no-prompt",
    "[iac-compose] DRY deploy: function app",
    "[iac-compose] DRY command: patch logic workflow",
  ]);
  assert.equal(messages.some((message) => message.includes("env new")), false);
});

test("deployment scopes preserve component selection", () => {
  const deployment = createDeployment({ component: "logic-app" });

  assert.equal(deployment.component, "logic-app");
  assert.equal(deployment.inDirectory("nested").component, "logic-app");
});

test("role assignments use the stable Foundry role definition ID", async () => {
  const commands: Command[] = [];
  class RoleDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      commands.push(command);
      return "";
    }

    override async execute(command: Command): Promise<void> {
      commands.push(command);
    }
  }

  await ensureRoleAssignment(new RoleDeployment(), {
    principalId: "principal-id",
    role: "Azure AI User",
    scope: "/subscriptions/subscription-id/resourceGroups/resources",
  });

  assert.equal(commands.length, 2);
  for (const command of commands) {
    const roleIndex = command.args?.indexOf("--role") ?? -1;
    assert.equal(
      command.args?.[roleIndex + 1],
      "53ca6127-db72-4b80-b1b0-d745d6d5456d",
    );
  }
});

test("App Service readiness waits for a ready site instance", async () => {
  const commands: Command[] = [];
  const states = ["STARTING", "READY"];
  class ReadyDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      commands.push(command);
      return `${states.shift() ?? "READY"}\n`;
    }
  }

  await waitForAppServiceReady(new ReadyDeployment(), {
    resourceGroup: "resources",
    siteName: "backend",
    subscription: "subscription",
    attempts: 2,
    delayMs: 0,
  });

  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0]?.args, [
    "rest",
    "--method",
    "get",
    "--uri",
    "https://management.azure.com/subscriptions/subscription/resourceGroups/resources/providers/Microsoft.Web/sites/backend/instances?api-version=2024-11-01",
    "--query",
    "value[0].properties.state",
    "--output",
    "tsv",
  ]);
});

test("restores a missing user-assigned App Service container pull identity", async () => {
  const commands: Command[] = [];
  class ContainerIdentityDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      commands.push(command);
      if (command.args?.[1] === "identity") {
        return JSON.stringify({
          userAssignedIdentities: {
            "/identities/backend": { clientId: "backend-client-id" },
          },
        });
      }
      return "";
    }

    override async execute(command: Command): Promise<void> {
      commands.push(command);
    }
  }

  await ensureAppServiceContainerPullIdentity(
    new ContainerIdentityDeployment(),
    {
      resourceGroup: "resources",
      siteName: "backend",
      subscription: "subscription",
    },
  );

  assert.equal(commands.length, 3);
  assert.deepEqual(commands[2]?.args, [
    "webapp",
    "config",
    "set",
    "--subscription",
    "subscription",
    "--resource-group",
    "resources",
    "--name",
    "backend",
    "--generic-configurations",
    JSON.stringify({
      acrUseManagedIdentityCreds: true,
      acrUserManagedIdentityID: "backend-client-id",
    }),
    "--output",
    "none",
  ]);
});

test("App Service client authorization preserves auth settings and replaces callers", async () => {
  const commands: Command[] = [];
  class ClientAuthorizationDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      commands.push(command);
      if (command.args?.some((argument) =>
        argument.includes("/instances?api-version=2024-11-01")
      )) {
        return "READY\n";
      }
      return JSON.stringify({
        properties: {
          platform: { enabled: true },
          identityProviders: {
            azureActiveDirectory: {
              enabled: true,
              validation: {
                allowedAudiences: ["api://backend"],
                defaultAuthorizationPolicy: {
                  allowedApplications: ["stale-client"],
                  allowedPrincipals: {},
                },
              },
            },
          },
        },
      });
    }

    override async execute(command: Command): Promise<void> {
      commands.push(command);
    }
  }

  await ensureAppServiceClientAuthorization(
    new ClientAuthorizationDeployment(),
    {
      resourceGroup: "resources",
      siteName: "backend",
      subscription: "subscription",
      allowedApplicationIds: ["azure-cli", "bot-client", "BOT-CLIENT"],
    },
  );

  assert.equal(commands.length, 4);
  assert.deepEqual(commands[0]?.args, [
    "rest",
    "--method",
    "get",
    "--uri",
    "https://management.azure.com/subscriptions/subscription/resourceGroups/resources/providers/Microsoft.Web/sites/backend/config/authsettingsV2?api-version=2023-12-01",
    "--output",
    "json",
  ]);
  const bodyIndex = commands[1]?.args?.indexOf("--body") ?? -1;
  const body = JSON.parse(commands[1]?.args?.[bodyIndex + 1] ?? "null");
  assert.deepEqual(
    body.properties.identityProviders.azureActiveDirectory.validation,
    {
      allowedAudiences: ["api://backend"],
      defaultAuthorizationPolicy: {
        allowedApplications: ["azure-cli", "bot-client"],
        allowedPrincipals: {},
      },
    },
  );
  assert.deepEqual(body.properties.platform, { enabled: true });
  assert.deepEqual(commands[2]?.args, [
    "webapp",
    "restart",
    "--subscription",
    "subscription",
    "--resource-group",
    "resources",
    "--name",
    "backend",
    "--output",
    "none",
  ]);
  assert.ok(commands[3]?.args?.includes(
    "https://management.azure.com/subscriptions/subscription/resourceGroups/resources/providers/Microsoft.Web/sites/backend/instances?api-version=2024-11-01",
  ));
});

test("App Service client authorization skips an unchanged policy", async () => {
  const commands: Command[] = [];
  class UnchangedClientAuthorizationDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      commands.push(command);
      return JSON.stringify({
        properties: {
          identityProviders: {
            azureActiveDirectory: {
              validation: {
                defaultAuthorizationPolicy: {
                  allowedApplications: ["bot-client", "azure-cli"],
                  allowedPrincipals: {},
                },
              },
            },
          },
        },
      });
    }
  }

  await ensureAppServiceClientAuthorization(
    new UnchangedClientAuthorizationDeployment(),
    {
      resourceGroup: "resources",
      siteName: "backend",
      subscription: "subscription",
      allowedApplicationIds: ["azure-cli", "bot-client"],
    },
  );

  assert.equal(commands.length, 1);
});

test("App Service ingress preserves existing rules and adds only missing tags", async () => {
  const commands: Command[] = [];
  class IngressDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      commands.push(command);
      return JSON.stringify([
        {
          action: "Allow",
          ipAddress: "CorpNetPublic",
          priority: 101,
          tag: "ServiceTag",
        },
        {
          action: "Allow",
          ipAddress: "LogicApps",
          priority: 200,
          tag: "ServiceTag",
        },
        { action: "Deny", ipAddress: "Any", priority: 2147483647 },
      ]);
    }

    override async execute(command: Command): Promise<void> {
      commands.push(command);
    }
  }

  const added = await ensureAppServiceIngress(new IngressDeployment(), {
    resourceGroup: "resources",
    siteName: "backend",
    serviceTags: ["LogicApps", "AppService", "AppService"],
    subscription: "subscription",
  });

  assert.deepEqual(added, ["AppService"]);
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.args?.includes("remove"), false);
  assert.deepEqual(commands[1]?.args?.slice(-6), [
    "--priority",
    "201",
    "--service-tag",
    "AppService",
    "--output",
    "none",
  ]);
});

test("App Service ingress enforces the unmatched traffic action", async () => {
  const commands: Command[] = [];
  class DefaultActionDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      commands.push(command);
      return command.args?.includes("ipSecurityRestrictionsDefaultAction")
        ? "Allow\n"
        : "[]";
    }

    override async execute(command: Command): Promise<void> {
      commands.push(command);
    }
  }

  const added = await ensureAppServiceIngress(
    new DefaultActionDeployment(),
    {
      resourceGroup: "resources",
      siteName: "backend",
      serviceTags: [],
      defaultAction: "Deny",
      subscription: "subscription",
    },
  );

  assert.deepEqual(added, []);
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[2]?.args?.slice(-4), [
    "--default-action",
    "Deny",
    "--output",
    "none",
  ]);
});

test("App Service public ingress removes a stale catch-all deny rule", async () => {
  const commands: Command[] = [];
  class PublicIngressDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      commands.push(command);
      return command.args?.includes("ipSecurityRestrictionsDefaultAction")
        ? "Deny\n"
        : JSON.stringify([
            {
              action: "Deny",
              ipAddress: "Any",
              name: "Deny all",
              priority: 2147483647,
            },
          ]);
    }

    override async execute(command: Command): Promise<void> {
      commands.push(command);
    }
  }

  const added = await ensureAppServiceIngress(new PublicIngressDeployment(), {
    resourceGroup: "resources",
    siteName: "backend",
    serviceTags: [],
    defaultAction: "Allow",
    subscription: "subscription",
  });

  assert.deepEqual(added, []);
  assert.deepEqual(commands[1]?.args?.slice(-6), [
    "--rule-name",
    "Deny all",
    "--action",
    "Deny",
    "--output",
    "none",
  ]);
  assert.deepEqual(commands[3]?.args?.slice(-4), [
    "--default-action",
    "Allow",
    "--output",
    "none",
  ]);
});

test("App Service peer ingress allows only missing possible outbound IPs", async () => {
  const commands: Command[] = [];
  class PeerIngressDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      commands.push(command);
      if (command.args?.[1] === "show") {
        return "10.0.0.1,10.0.0.2\n";
      }
      return JSON.stringify([
        {
          action: "Allow",
          ipAddress: "CorpNetPublic",
          priority: 101,
          tag: "ServiceTag",
        },
        {
          action: "Allow",
          ipAddress: "LogicApps",
          priority: 200,
          tag: "ServiceTag",
        },
        {
          action: "Allow",
          ipAddress: "10.0.0.1/32",
          priority: 201,
        },
      ]);
    }

    override async execute(command: Command): Promise<void> {
      commands.push(command);
    }
  }

  const added = await ensureAppServicePeerIngress(
    new PeerIngressDeployment(),
    {
      resourceGroup: "resources",
      sourceSiteName: "frontend",
      targetSiteName: "backend",
      sourceResourceName: "frontendCompute",
      subscription: "subscription",
    },
  );

  assert.deepEqual(added, ["10.0.0.2"]);
  const addCommand = commands.find((command) =>
    command.args?.includes("--ip-address"),
  );
  assert.ok(addCommand);
  assert.equal(
    addCommand.args?.[addCommand.args.indexOf("--name") + 1],
    "backend",
  );
  assert.deepEqual(addCommand.args?.slice(-6), [
    "--priority",
    "202",
    "--ip-address",
    "10.0.0.2",
    "--output",
    "none",
  ]);
});

test("App Service private networking integrates the source with a target private endpoint", async () => {
  const captured: Command[] = [];
  const executed: Command[] = [];
  class PrivateEndpointDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      captured.push(command);
      if (command.args?.includes("vnet-integration")) return "[]";
      if (command.args?.includes("publicNetworkAccess")) return "Enabled\n";
      if (command.args?.includes("access-restriction")) {
        return JSON.stringify([
          { action: "Allow", name: "Allow frontendCompute 1" },
          { action: "Allow", name: "Allow anotherFrontend 1" },
          { action: "Deny", name: "Deny all" },
        ]);
      }
      return "";
    }

    override async execute(command: Command): Promise<void> {
      executed.push(command);
    }
  }

  await ensureAppServicePrivateEndpoint(new PrivateEndpointDeployment(), {
    resourceGroup: "resources",
    location: "westus2",
    sourceSiteName: "frontend",
    targetSiteName: "backend",
    sourceResourceName: "frontendCompute",
    targetResourceName: "backendCompute",
    subscription: "subscription",
    publicNetworkAccess: "Disabled",
  });

  assert.equal(
    [...captured, ...executed].some((command) =>
      command.args?.includes("possibleOutboundIpAddresses"),
    ),
    false,
  );
  assert.equal(
    executed.filter((command) => command.args?.includes("access-restriction"))
      .length,
    1,
  );
  const legacyRuleCleanup = executed.find((command) =>
    command.args?.includes("access-restriction"),
  );
  assert.ok(legacyRuleCleanup);
  assert.equal(
    legacyRuleCleanup.args?.[
      legacyRuleCleanup.args.indexOf("--rule-name") + 1
    ],
    "Allow frontendCompute 1",
  );
  const integration = executed.find(
    (command) =>
      command.args?.[0] === "webapp" &&
      command.args?.[1] === "vnet-integration" &&
      command.args?.[2] === "add",
  );
  assert.ok(integration);
  assert.equal(
    integration.args?.[integration.args.indexOf("--name") + 1],
    "frontend",
  );
  assert.equal(
    integration.args?.[integration.args.indexOf("--subnet") + 1],
    "integration-frontendcompute",
  );
  const privateEndpoint = executed.find(
    (command) =>
      command.args?.[0] === "network" &&
      command.args?.[1] === "private-endpoint" &&
      command.args?.[2] === "create",
  );
  assert.ok(privateEndpoint);
  assert.equal(
    privateEndpoint.args?.[
      privateEndpoint.args.indexOf("--private-connection-resource-id") + 1
    ],
    "/subscriptions/subscription/resourceGroups/resources/providers/Microsoft.Web/sites/backend",
  );
  assert.equal(
    privateEndpoint.args?.[privateEndpoint.args.indexOf("--group-id") + 1],
    "sites",
  );
  assert.ok(
    executed.some(
      (command) =>
        command.args?.[0] === "network" &&
        command.args?.[1] === "private-endpoint" &&
        command.args?.[2] === "dns-zone-group" &&
        command.args?.[3] === "create",
    ),
  );
  const publicAccess = executed.find(
    (command) =>
      command.args?.[0] === "webapp" && command.args?.[1] === "update",
  );
  assert.ok(publicAccess);
  assert.ok(publicAccess.args?.includes("publicNetworkAccess=Disabled"));
});

test("App Service private networking preserves an existing configuration", async () => {
  const executed: Command[] = [];
  class ExistingPrivateEndpointDeployment extends Deployment {
    override async capture(command: Command): Promise<string> {
      if (command.args?.includes("vnet-integration")) {
        return JSON.stringify([
          {
            vnetResourceId:
              "/subscriptions/subscription/resourceGroups/resources/providers/Microsoft.Network/virtualNetworks/appservice-private-network/subnets/integration-frontendcompute",
          },
        ]);
      }
      if (command.args?.includes("publicNetworkAccess")) return "Disabled\n";
      if (command.args?.includes("access-restriction")) return "[]";
      return "/subscriptions/subscription/resourceGroups/resources/resource\n";
    }

    override async execute(command: Command): Promise<void> {
      executed.push(command);
    }
  }

  await ensureAppServicePrivateEndpoint(
    new ExistingPrivateEndpointDeployment(),
    {
      resourceGroup: "resources",
      location: "westus2",
      sourceSiteName: "frontend",
      targetSiteName: "backend",
      sourceResourceName: "frontendCompute",
      targetResourceName: "backendCompute",
      subscription: "subscription",
      publicNetworkAccess: "Disabled",
    },
  );

  assert.deepEqual(executed, []);
});

test("Teams provisioning uses the component-authored lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-compose-teams-"));
  const source = join(root, "source");
  await mkdir(join(source, "env"), { recursive: true });
  const sourceLifecycle = `version: v1.7
provision:
  - uses: teamsApp/create
  - uses: teamsApp/validateAppPackage
`;
  await writeFile(join(source, "teamsapp.yml"), sourceLifecycle);

  class TeamsDeployment extends Deployment {
    override async execute(command: Command): Promise<void> {
      assert.equal(command.cwd, source);
      assert.equal(await readFile(join(source, "teamsapp.yml"), "utf8"), sourceLifecycle);
      const environmentFile = join(source, "env", ".env.iac-compose-dev");
      assert.match(
        await readFile(environmentFile, "utf8"),
        /TEAMS_APP_ID=existing-app-id/,
      );
      assert.equal(command.env?.TEAMS_APP_ID, "existing-app-id");
      await writeFile(
        environmentFile,
        `${await readFile(environmentFile, "utf8")}TEAMS_APP_ID=existing-app-id\n`,
      );
    }
  }

  const outputs = await provisionTeamsApplication(
    new TeamsDeployment({ environment: "dev" }),
    {
      component: "frontend",
      componentDirectory: source,
      existingAppId: "existing-app-id",
      manifestValues: { TEAMS_APP_NAME: "Test app" },
      outputNames: ["teamsAppId"],
    },
  );

  assert.deepEqual(outputs, {
    TEAMS_APP_ID: "existing-app-id",
    teamsAppId: "existing-app-id",
  });
  assert.equal(
    await readFile(join(source, "teamsapp.yml"), "utf8"),
    sourceLifecycle,
  );
});

test("Teams provisioning leaves the generated app package for publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-compose-teams-package-"));
  const source = join(root, "source");
  await mkdir(join(source, "env"), { recursive: true });
  await mkdir(join(source, "appPackage", "build"), { recursive: true });
  await writeFile(join(source, "teamsapp.yml"), "version: v1.7\n");
  await writeFile(
    join(
      source,
      "appPackage",
      "build",
      "appPackage.iac-compose-dev.zip",
    ),
    "package",
  );
  const manifestId = "9668bcb5-a50b-4e39-a136-b3301305de66";
  const commands: Command[] = [];

  class TeamsPackageDeployment extends Deployment {
    override async execute(command: Command): Promise<void> {
      commands.push(command);
      if (command.command === "npx" && command.args?.includes("provision")) {
        const environmentFile = join(
          source,
          "env",
          ".env.iac-compose-dev",
        );
        await writeFile(
          environmentFile,
          `${await readFile(environmentFile, "utf8")}TEAMS_APP_ID=${manifestId}\n`,
        );
      }
    }
  }

  const outputs = await provisionTeamsApplication(
    new TeamsPackageDeployment({ environment: "dev" }),
    {
      component: "frontend",
      componentDirectory: source,
      existingAppId: manifestId,
      manifestValues: { TEAMS_APP_NAME: "Test app" },
      outputNames: ["teamsAppId"],
    },
  );

  assert.deepEqual(outputs, {
    TEAMS_APP_ID: manifestId,
    teamsAppId: manifestId,
  });
  assert.equal(
    await readFile(
      join(
        source,
        "appPackage",
        "build",
        "appPackage.iac-compose-dev.zip",
      ),
      "utf8",
    ),
    "package",
  );
  const environment = await readFile(
    join(source, "env", ".env.iac-compose-dev"),
    "utf8",
  );
  const version = /^TEAMS_APP_VERSION=(\d+)\.(\d+)\.(\d+)$/m.exec(environment);
  assert.ok(version);
  assert.ok(version.slice(1).every((part) => Number(part) <= 65_535));
  assert.equal(
    commands.filter(
      (command) =>
        command.command === "npx" && command.args?.includes("install"),
    ).length,
    0,
  );
  assert.equal(
    commands.filter(
      (command) =>
        command.command === "az" && command.args?.includes("upload"),
    ).length,
    0,
  );
});