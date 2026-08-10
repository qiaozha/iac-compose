import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createDeployment,
  Deployment,
  ensureAppServiceIngress,
  ensureAppServicePeerIngress,
  ensureRoleAssignment,
  provisionTeamsApplication,
  type Command,
} from "../src/index.js";

test("dry run renders provision artifacts without running deployment actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-dry-run-"));
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
    "[deploy-js] DRY env: prepare shared values",
    "[deploy-js] DRY provision: chatbot resources",
    "[deploy-js] $ azd provision --environment dev --no-prompt",
    "[deploy-js] DRY deploy: function app",
    "[deploy-js] DRY command: patch logic workflow",
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

test("Teams provisioning uses the component-authored lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-teams-"));
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
      const environmentFile = join(source, "env", ".env.deploy-js-dev");
      await writeFile(
        environmentFile,
        `${await readFile(environmentFile, "utf8")}TEAMS_APP_ID=test-app-id\n`,
      );
    }
  }

  const outputs = await provisionTeamsApplication(
    new TeamsDeployment({ environment: "dev" }),
    {
      component: "frontend",
      componentDirectory: source,
      manifestValues: { TEAMS_APP_NAME: "Test app" },
      outputNames: ["teamsAppId"],
    },
  );

  assert.deepEqual(outputs, {
    TEAMS_APP_ID: "test-app-id",
    teamsAppId: "test-app-id",
  });
  assert.equal(
    await readFile(join(source, "teamsapp.yml"), "utf8"),
    sourceLifecycle,
  );
});