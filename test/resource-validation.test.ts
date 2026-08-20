import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { Deployment, type Command } from "../src/index.js";
import {
  planResourceValidation,
  validateResourceRequirements,
} from "../src/validation/resources/index.js";

const execFileAsync = promisify(execFile);

test("plans generator providers and deployment data-plane roles", () => {
  const plan = planResourceValidation({
    schemaVersion: "1.0",
    solution: { name: "support", enabledComponents: ["agent"] },
    resources: [
      {
        id: "foundryProject",
        kind: "ai-project",
        requiredBy: ["agent"],
        capabilities: ["hosted-agent"],
        azureResourceTypes: ["Microsoft.CognitiveServices/accounts"],
      },
      {
        id: "runtimeConfiguration",
        kind: "configuration-store",
        requiredBy: ["agent"],
        azureResourceTypes: [
          "Microsoft.AppConfiguration/configurationStores",
        ],
      },
      {
        id: "agentCompute",
        kind: "container-host",
        requiredBy: ["agent"],
      },
    ],
  });

  assert.deepEqual(plan.providers, [
    "Microsoft.AppConfiguration",
    "Microsoft.CognitiveServices",
    "Microsoft.ContainerRegistry",
    "Microsoft.ManagedIdentity",
    "Microsoft.Web",
  ]);
  assert.deepEqual(
    plan.roles.map(({ role, roleDefinitionId }) => ({ role, roleDefinitionId })),
    [
      {
        role: "App Configuration Data Owner",
        roleDefinitionId: "5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b",
      },
      {
        role: "AcrPush",
        roleDefinitionId: "8311e382-0749-4cb8-b61a-304f252e45ec",
      },
      {
        role: "Foundry User",
        roleDefinitionId: "53ca6127-db72-4b80-b1b0-d745d6d5456d",
      },
    ],
  );
});

test("rejects providers that the resource-kind generator cannot emit", () => {
  assert.throws(
    () =>
      planResourceValidation({
        schemaVersion: "1.0",
        solution: { name: "support", enabledComponents: ["backend"] },
        resources: [
          {
            id: "runtimeConfiguration",
            kind: "configuration-store",
            requiredBy: ["backend"],
            azureResourceTypes: ["Microsoft.Storage/storageAccounts"],
          },
        ],
      }),
    /configuration-store.*does not support/,
  );
});

test("plans Microsoft.Network for App Service private endpoint relationships", () => {
  const plan = planResourceValidation({
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
        configuration: {
          ingress: {
            mode: "restricted",
            privateEndpoint: {
              sourceResources: ["frontendCompute"],
            },
          },
        },
        azureResourceTypes: [
          "Microsoft.Network/virtualNetworks",
          "Microsoft.Network/privateEndpoints",
          "Microsoft.Network/privateDnsZones",
        ],
      },
      {
        id: "frontendCompute",
        kind: "container-host",
        requiredBy: ["frontend"],
      },
    ],
  });

  assert.ok(plan.providers.includes("Microsoft.Network"));
});

test("validates inherited roles and grants only missing deployment access", async () => {
  const commands: Command[] = [];
  class ValidationDeployment extends Deployment {
    override async execute(command: Command): Promise<void> {
      commands.push(command);
    }

    override async capture(command: Command): Promise<string> {
      commands.push(command);
      const args = command.args ?? [];
      if (args[0] === "account" && args[1] === "show") return "tenant-id\n";
      if (args[0] === "provider" && args[1] === "show") return "Registered\n";
      if (args[0] === "role" && args[1] === "assignment") {
        const role = args[args.indexOf("--role") + 1];
        return role === "5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b"
          ? "assignment-id\n"
          : "";
      }
      throw new Error(`Unexpected capture: ${args.join(" ")}`);
    }
  }

  const result = await validateResourceRequirements(
    new ValidationDeployment(),
    {
      requirements: {
        schemaVersion: "1.0",
        solution: { name: "support", enabledComponents: ["agent"] },
        resources: [
          {
            id: "foundryProject",
            kind: "ai-project",
            requiredBy: ["agent"],
            capabilities: ["hosted-agent"],
          },
          {
            id: "runtimeConfiguration",
            kind: "configuration-store",
            requiredBy: ["agent"],
          },
          {
            id: "agentCompute",
            kind: "container-host",
            requiredBy: ["agent"],
          },
        ],
      },
      subscriptionId: "subscription-id",
      tenantId: "tenant-id",
      principalId: "principal-id",
      principalType: "ServicePrincipal",
      resourceGroup: "resources",
      grant: true,
    },
  );

  assert.equal(
    result.scope,
    "/subscriptions/subscription-id/resourceGroups/resources",
  );
  assert.equal(
    result.providers.every(
      ({ registrationState }) => registrationState === "Registered",
    ),
    true,
  );
  assert.deepEqual(
    result.roles.map(({ role, present, granted }) => ({
      role,
      present,
      granted,
    })),
    [
      { role: "App Configuration Data Owner", present: true, granted: false },
      { role: "AcrPush", present: true, granted: true },
      { role: "Foundry User", present: true, granted: true },
    ],
  );
  const createCommands = commands.filter(
    ({ args }) => args?.[0] === "role" && args[2] === "create",
  );
  assert.deepEqual(
    createCommands.map(({ args }) => args?.[args.indexOf("--role") + 1]),
    [
      "8311e382-0749-4cb8-b61a-304f252e45ec",
      "53ca6127-db72-4b80-b1b0-d745d6d5456d",
    ],
  );
  assert.equal(
    commands
      .filter(({ args }) => args?.[0] === "role" && args[2] === "list")
      .every(({ args }) => args?.includes("--include-inherited")),
    true,
  );
});

test("validate CLI reports access and grants missing roles explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-js-validate-"));
  const bin = join(root, "bin");
  const log = join(root, "az.log");
  const resourcesFile = join(root, "resource-requirements.json");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  await writeFile(
    resourcesFile,
    JSON.stringify({
      schemaVersion: "1.0",
      solution: { name: "support", enabledComponents: ["backend"] },
      resources: [
        {
          id: "runtimeConfiguration",
          kind: "configuration-store",
          requiredBy: ["backend"],
          azureResourceTypes: [
            "Microsoft.AppConfiguration/configurationStores",
          ],
        },
      ],
    }),
  );
  const fakeAzure = join(bin, "az");
  await writeFile(
    fakeAzure,
    `#!/bin/sh
printf '%s\n' "$*" >> "$DEPLOY_JS_AZ_LOG"
if [ "$1 $2" = "account show" ]; then printf 'tenant-id\n'; exit 0; fi
if [ "$1 $2" = "provider show" ]; then printf 'Registered\n'; exit 0; fi
if [ "$1 $2 $3" = "role assignment list" ]; then
  if [ "$DEPLOY_JS_ROLE_MISSING" = "1" ]; then exit 0; fi
  printf 'assignment-id\n'
  exit 0
fi
exit 0
`,
  );
  await chmod(fakeAzure, 0o755);
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    DEPLOY_JS_AZ_LOG: log,
  };
  const args = [
    resolve("dist/cli.js"),
    "validate",
    "--resources",
    resourcesFile,
    "--subscription",
    "subscription-id",
    "--tenant",
    "tenant-id",
    "--principal-id",
    "principal-id",
    "--resource-group",
    "resources",
  ];

  const validated = await execFileAsync(process.execPath, args, {
    env: environment,
  });
  assert.match(
    validated.stdout,
    /provider Microsoft\.AppConfiguration: Registered/,
  );
  assert.match(validated.stdout, /role App Configuration Data Owner: present/);
  assert.match(validated.stdout, /validated deployment principal principal-id/);

  const granted = await execFileAsync(process.execPath, [...args, "--grant"], {
    env: { ...environment, DEPLOY_JS_ROLE_MISSING: "1" },
  });
  assert.match(granted.stdout, /role App Configuration Data Owner: granted/);
  assert.match(
    await readFile(log, "utf8"),
    /role assignment create.*--role 5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b/,
  );
});