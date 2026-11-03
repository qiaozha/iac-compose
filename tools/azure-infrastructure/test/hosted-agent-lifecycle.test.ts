import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Deployment,
  type Command,
  type ProvisionOptions,
  type ProvisionOutputs,
} from "iac-composer";
import {
  deployHostedAgentService,
  waitForHostedAgentVersion,
  type HostedAgentConfiguration,
} from "../src/runtime/services/hosted-agent.js";

const configuration: HostedAgentConfiguration = {
  name: "customer-agent",
  language: "dotnet",
  container: { cpu: "2", memory: "4Gi" },
  startupCommand: "dotnet Customer.Agent.dll",
  protocols: [{ protocol: "responses", version: "2.0.0" }],
  docker: {
    registry: "${CUSTOM_REGISTRY}",
    path: "docker/agent.Dockerfile",
    context: "source",
    image: "customer/agent",
    tag: "release-7",
    remoteBuild: false,
  },
  environment: { CUSTOM_SETTING: "customer-value" },
};

class ServiceDeployment extends Deployment {
  readonly events: string[] = [];
  readonly commands: Command[] = [];
  statuses = ["starting", "active"];
  shows = 0;
  provisionFailure?: Error;
  deployFailure?: Error;
  lookupFailure?: Error;
  endpoint = "https://customer-agent.example";

  override async provision(_name: string, _options: ProvisionOptions): Promise<ProvisionOutputs> {
    this.events.push("provision");
    if (this.provisionFailure) throw this.provisionFailure;
    return { AGENT_RESOURCE_NAME: "provisioned-agent", CUSTOM_REGISTRY: "registry.example" };
  }

  override async execute(command: Command): Promise<void> {
    this.commands.push(command);
    if (command.command === "azd" && command.args?.[0] === "deploy") {
      this.events.push("deploy");
      if (this.deployFailure) throw this.deployFailure;
    }
    if (command.command === "az") {
      this.events.push("grant");
    }
  }

  override async capture(command: Command): Promise<string> {
    this.commands.push(command);
    if (command.args?.[0] === "env") {
      return this.endpoint ? `CUSTOMER_AGENT_ENDPOINT="${this.endpoint}"\n` : "";
    }
    if (command.args?.[0] === "ai") {
      this.events.push("status");
      if (this.lookupFailure) throw this.lookupFailure;
      const status = this.statuses[Math.min(this.shows++, this.statuses.length - 1)];
      return JSON.stringify({
        name: "customer-agent",
        version: "7",
        status,
        instance_identity: { principal_id: "agent-principal" },
      });
    }
    if (command.args?.[0] === "role") return "";
    throw new Error(`Unexpected capture: ${command.args?.join(" ")}`);
  }
}

async function withProject(
  action: (root: string, directory: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-agent-lifecycle-"));
  const previous = process.env.CUSTOMER_AGENT_ENDPOINT;
  try {
    const directory = join(root, ".generated");
    await mkdir(join(directory, ".azure/dev"), { recursive: true });
    await writeFile(join(directory, ".azure/dev/config.json"), "{}");
    await action(root, directory);
  } finally {
    if (previous === undefined) delete process.env.CUSTOMER_AGENT_ENDPOINT;
    else process.env.CUSTOMER_AGENT_ENDPOINT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("service lifecycle provisions, configures, builds/deploys, waits, grants requested access and returns typed outputs", async () => {
  await withProject(async (root, directory) => {
    const deployment = new ServiceDeployment({ environment: "dev", log: () => {} });
    const result = await deployHostedAgentService(deployment, {
      service: "customer",
      directory,
      sourceDirectory: root,
      provision: { entrypoint: "customer-infra.ts" },
      configuration: (outputs) => {
        deployment.events.push("configure");
        assert.equal(outputs.AGENT_RESOURCE_NAME, "provisioned-agent");
        return {
          ...configuration,
          name: outputs.AGENT_RESOURCE_NAME,
          access: [{ role: "customer-role", scope: "/customer-resource" }],
        };
      },
      readiness: { attempts: 3, delayMs: 0 },
    });

    assert.deepEqual(deployment.events, [
      "provision", "configure", "deploy", "status", "status", "grant",
    ]);
    assert.equal(result.status, "deployed");
    if (result.status !== "deployed") assert.fail("Expected a deployed result");
    assert.equal(result.endpoint, "https://customer-agent.example");
    assert.equal(result.principalId, "agent-principal");
    assert.equal(result.agent.version, "7");
    assert.equal(result.infrastructureOutputs.CUSTOM_REGISTRY, "registry.example");
    assert.equal(result.deploymentOutputs.CUSTOMER_AGENT_ENDPOINT, result.endpoint);
    const manifest = JSON.parse(await readFile(join(directory, "azure.yaml"), "utf8"));
    const service = manifest.services.customer;
    assert.equal(service.language, "dotnet");
    assert.equal(service.startupCommand, "dotnet Customer.Agent.dll");
    assert.deepEqual(service.container.resources, { cpu: "2", memory: "4Gi" });
    assert.deepEqual(service.docker, {
      path: join(root, "docker/agent.Dockerfile"),
      context: join(root, "source"),
      registry: "${CUSTOM_REGISTRY}",
      image: "customer/agent",
      tag: "release-7",
      remoteBuild: false,
    });
    assert.deepEqual(service.env, { CUSTOM_SETTING: "${CUSTOM_SETTING}" });
    assert.doesNotMatch(JSON.stringify(manifest), /python|init\.py|APPCONFIG/);
    const grants = deployment.commands.filter(
      (command) => command.command === "az" && command.args?.[2] === "create",
    );
    assert.equal(grants.length, 1);
    assert.ok(grants[0].args?.includes("agent-principal"));
    assert.ok(grants[0].args?.includes("customer-role"));
    assert.ok(grants[0].args?.includes("/customer-resource"));
  });
});

test("existing infrastructure and prebuilt images use the same deployment/readiness lifecycle", async () => {
  await withProject(async (root, directory) => {
    const deployment = new ServiceDeployment({ environment: "dev", log: () => {} });
    deployment.statuses = ["active"];
    const result = await deployHostedAgentService(deployment, {
      service: "customer",
      directory,
      sourceDirectory: root,
      configuration: { ...configuration, startupCommand: undefined },
      deploy: { fromPackage: "registry.example/customer@sha256:example", timeout: 240 },
      readiness: { attempts: 1, delayMs: 0 },
    });
    assert.equal(result.status, "deployed");
    assert.deepEqual(deployment.events, ["deploy", "status"]);
    const deploy = deployment.commands.find((command) => command.args?.[0] === "deploy");
    assert.deepEqual(deploy?.args, [
      "deploy", "customer", "--environment", "dev", "--no-prompt",
      "--from-package", "registry.example/customer@sha256:example", "--timeout", "240",
    ]);
    const manifest = JSON.parse(await readFile(join(directory, "azure.yaml"), "utf8"));
    assert.equal(Object.hasOwn(manifest.services.customer, "startupCommand"), false);
  });
});

test("dry run compiles real infrastructure and service manifests without cloud or app actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "iac-composer-agent-preview-"));
  try {
    const entrypoint = join(root, "infra.ts");
    const directory = join(root, ".generated");
    await writeFile(entrypoint, `export const outputBicep = [
      { path: "main.bicep", contents: "targetScope = 'resourceGroup'\\n" },
      { path: "main.bicepparam", contents: "using './main.bicep'\\n" },
    ];`);
    const messages: string[] = [];
    const result = await deployHostedAgentService(
      new Deployment({
        projectDirectory: root,
        environment: "dev",
        dryRun: true,
        log: (message) => messages.push(message),
      }),
      {
        service: "customer",
        directory,
        sourceDirectory: root,
        provision: { entrypoint, outputDirectory: join(directory, "customer") },
        configuration,
      },
    );
    assert.deepEqual(result, { status: "preview", infrastructureOutputs: {} });
    assert.equal(Object.hasOwn(result, "endpoint"), false);
    assert.equal(Object.hasOwn(result, "principalId"), false);
    await access(join(directory, "customer/main.bicep"));
    const manifest = JSON.parse(await readFile(join(directory, "azure.yaml"), "utf8"));
    assert.equal(manifest.services.customer.host, "azure.ai.agent");
    assert.equal(manifest.infra.layers[0].name, "customer");
    assert.ok(messages.indexOf("[iac-composer] DRY provision: customer infrastructure") <
      messages.indexOf("[iac-composer] DRY deploy: customer hosted Foundry agent"));
    assert.equal(messages.some((message) => /ai agent show|role assignment|appconfig/.test(message)), false);
    await assert.rejects(access(join(directory, ".azure")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const stage of ["provision", "configure", "deploy", "lookup", "terminal", "endpoint"] as const) {
  test(`failure at ${stage} stops the lifecycle before success or access grants`, async () => {
    await withProject(async (root, directory) => {
      const deployment = new ServiceDeployment({ environment: "dev", log: () => {} });
      const failure = new Error(`customer-${stage}-failed`);
      if (stage === "provision") deployment.provisionFailure = failure;
      if (stage === "deploy") deployment.deployFailure = failure;
      if (stage === "lookup") deployment.lookupFailure = failure;
      if (stage === "terminal") deployment.statuses = ["failed"];
      if (stage === "endpoint") {
        deployment.statuses = ["active"];
        deployment.endpoint = "";
      }
      await assert.rejects(deployHostedAgentService(deployment, {
        service: "customer",
        directory,
        sourceDirectory: root,
        provision: { entrypoint: "infra.ts" },
        configuration: stage === "configure" ? async () => { throw failure; } : configuration,
        readiness: { attempts: 3, delayMs: 0 },
      }), stage === "terminal" ? /status 'failed'/ :
        stage === "endpoint" ? /did not return an endpoint/ : failure);
      assert.equal(deployment.events.includes("grant"), false);
      if (stage === "provision" || stage === "configure") {
        assert.equal(deployment.events.includes("deploy"), false);
      }
      if (stage === "deploy") assert.equal(deployment.shows, 0);
      if (stage === "terminal") assert.equal(deployment.shows, 1);
    });
  });
}

test("readiness polling is bounded and does not retry unknown or terminal statuses", async () => {
  let captures = 0;
  const project = {
    environment: "dev",
    capture: async () => {
      captures += 1;
      return '{"name":"agent","version":"1","status":"starting"}';
    },
  };
  await assert.rejects(
    waitForHostedAgentVersion(project, "customer", { attempts: 3, delayMs: 0 }),
    /not ready.*starting/,
  );
  assert.equal(captures, 3);
  for (const status of ["stopped", "unexpected-status"]) {
    captures = 0;
    await assert.rejects(waitForHostedAgentVersion({
      environment: "dev",
      capture: async () => {
        captures += 1;
        return JSON.stringify({ name: "agent", version: "1", status });
      },
    }, "customer", { attempts: 3, delayMs: 0 }), /expected 'active'/);
    assert.equal(captures, 1);
  }
});

test("invalid static configuration and readiness settings fail before provisioning", async () => {
  const deployment = new ServiceDeployment({ log: () => {} });
  const options = {
    service: "customer",
    directory: ".generated",
    sourceDirectory: ".",
    provision: { entrypoint: "infra.ts" },
    configuration,
  };
  await assert.rejects(
    deployHostedAgentService(deployment, { ...options, readiness: { attempts: 0 } }),
    /positive integer attempts/,
  );
  await assert.rejects(
    deployHostedAgentService(deployment, {
      ...options,
      configuration: { ...configuration, language: "" },
    }),
    /language must be non-empty/,
  );
  assert.deepEqual(deployment.events, []);
});
