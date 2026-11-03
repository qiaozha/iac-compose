import { resolve } from "node:path";
import {
  getAzdProject,
  type AzdDeployOptions,
  type AzdEnvironmentValues,
  type AzdProject,
} from "iac-composer";
import { ensureRoleAssignment, retry } from "iac-composer";
import type { Deployment, ProvisionOptions, ProvisionOutputs } from "iac-composer";

export interface HostedAgentAccess {
  role: string;
  scope: string;
}

export interface HostedAgentConfiguration {
  name: string;
  description?: string;
  language: string;
  container: {
    cpu: string;
    memory: string;
  };
  startupCommand?: string;
  protocols: readonly { protocol: string; version: string }[];
  docker: {
    registry: string;
    path?: string;
    context?: string;
    image?: string;
    tag?: string;
    remoteBuild?: boolean;
  };
  environment?: Readonly<Record<string, string>>;
  deploymentValues?: AzdEnvironmentValues;
  access?: readonly HostedAgentAccess[];
  endpointOutput?: string;
}

export interface HostedAgentServiceOptions {
  service: string;
  directory: string;
  sourceDirectory: string;
  provision?: ProvisionOptions;
  configuration:
    | HostedAgentConfiguration
    | ((infrastructureOutputs: ProvisionOutputs) =>
        HostedAgentConfiguration | Promise<HostedAgentConfiguration>);
  deploy?: AzdDeployOptions;
  readiness?: HostedAgentReadinessOptions;
}

export interface HostedAgentReadinessOptions {
  attempts?: number;
  delayMs?: number;
}

export type HostedAgentServiceResult =
  | {
      status: "preview";
      infrastructureOutputs: ProvisionOutputs;
    }
  | {
      status: "deployed";
      infrastructureOutputs: ProvisionOutputs;
      deploymentOutputs: Record<string, string>;
      agent: ActiveHostedAgentVersion;
      endpoint: string;
      principalId: string;
    };

export async function deployHostedAgentService(
  deployment: Deployment,
  options: HostedAgentServiceOptions,
): Promise<HostedAgentServiceResult> {
  const readiness = hostedAgentReadiness(options.readiness);
  const sourceDirectory = resolve(deployment.projectDirectory, options.sourceDirectory);
  const initialManifest = typeof options.configuration === "function"
    ? undefined
    : createHostedAgentManifest(options.service, sourceDirectory, options.configuration);
  const infrastructureOutputs = options.provision
    ? await deployment.provision(`${options.service} infrastructure`, options.provision)
    : {};
  const configuration = typeof options.configuration === "function"
    ? await options.configuration(infrastructureOutputs)
    : options.configuration;
  const project = getAzdProject(deployment, {
    directory: options.directory,
    mergeManifest: true,
    manifest: initialManifest ?? createHostedAgentManifest(options.service, sourceDirectory, configuration),
    values: {
      ...infrastructureOutputs,
      ...configuration.deploymentValues,
      ...configuration.environment,
    },
  });
  if (deployment.dryRun) await project.initialize();

  let result: HostedAgentServiceResult | undefined;
  await deployment.deploy(`${options.service} hosted Foundry agent`, async () => {
    const deploymentOutputs = await project.deploy(options.service, options.deploy);
    const agent = await waitForHostedAgentVersion(project, options.service, readiness);
    const principalId = agent.instance_identity.principal_id;
    const prefix = options.service.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
    const endpoint = configuration.endpointOutput
      ? deploymentOutputs[configuration.endpointOutput]?.trim()
      : deploymentOutputs[`${prefix}_AGENT_ENDPOINT`]?.trim() ||
        deploymentOutputs[`${prefix}_ENDPOINT`]?.trim();
    if (!endpoint) {
      throw new Error(`azd deploy did not return an endpoint for hosted agent '${options.service}'.`);
    }
    for (const access of configuration.access ?? []) {
      await ensureRoleAssignment(deployment, {
        principalId,
        role: access.role,
        scope: access.scope,
      });
    }
    result = {
      status: "deployed",
      infrastructureOutputs,
      deploymentOutputs,
      agent,
      endpoint,
      principalId,
    };
  });
  if (deployment.dryRun) return { status: "preview", infrastructureOutputs };
  if (!result) {
    throw new Error(`Hosted agent '${options.service}' deployment action did not execute.`);
  }
  return result;
}

function createHostedAgentManifest(
  service: string,
  sourceDirectory: string,
  configuration: HostedAgentConfiguration,
): Readonly<Record<string, unknown>> {
  for (const [field, value] of Object.entries({
    name: configuration.name,
    ...(configuration.description ? { description: configuration.description } : {}),
    language: configuration.language,
    cpu: configuration.container.cpu,
    memory: configuration.container.memory,
    registry: configuration.docker.registry,
  })) {
    if (!value.trim()) throw new Error(`Hosted agent ${field} must be non-empty.`);
  }
  if (configuration.protocols.length === 0) {
    throw new Error("Hosted agents require at least one protocol.");
  }
  for (const protocol of configuration.protocols) {
    if (!protocol.protocol.trim() || !protocol.version.trim()) {
      throw new Error("Hosted agent protocols require non-empty protocol and version values.");
    }
  }
  if (configuration.startupCommand !== undefined && !configuration.startupCommand.trim()) {
    throw new Error("Hosted agent startupCommand must be non-empty when supplied.");
  }
  return {
    name: `deploy-${service}`,
    services: {
      [service]: {
        project: ".",
        host: "azure.ai.agent",
        language: configuration.language,
        docker: {
          path: resolve(sourceDirectory, configuration.docker.path ?? "Dockerfile"),
          context: resolve(sourceDirectory, configuration.docker.context ?? "."),
          registry: configuration.docker.registry,
          image: configuration.docker.image ?? service,
          ...(configuration.docker.tag ? { tag: configuration.docker.tag } : {}),
          remoteBuild: configuration.docker.remoteBuild ?? true,
        },
        kind: "hosted",
        name: configuration.name,
        protocols: configuration.protocols,
        config: { container: { resources: configuration.container } },
        container: { resources: configuration.container },
        ...(configuration.startupCommand
          ? { startupCommand: configuration.startupCommand }
          : {}),
        env: Object.fromEntries(
          Object.keys(configuration.environment ?? {}).map((name) => [name, `\${${name}}`]),
        ),
      },
    },
  };
}

export interface HostedAgentVersion {
  name: string;
  version: string;
  status: string;
  instance_identity?: { principal_id?: string };
}

export type ActiveHostedAgentVersion = HostedAgentVersion & {
  instance_identity: { principal_id: string };
};

export function parseHostedAgentVersion(output: string): HostedAgentVersion {
  const value: unknown = JSON.parse(output);
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !value.version.trim() ||
    !("status" in value) ||
    typeof value.status !== "string" ||
    !value.status.trim()
  ) {
    throw new Error("azd ai agent show returned an invalid agent version.");
  }
  const result: HostedAgentVersion = {
    name: value.name,
    version: value.version,
    status: value.status,
  };
  const identity = "instance_identity" in value ? value.instance_identity : undefined;
  if (identity !== undefined) {
    if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
      throw new Error("azd ai agent show returned an invalid agent instance identity.");
    }
    if ("principal_id" in identity) {
      if (typeof identity.principal_id !== "string" || !identity.principal_id.trim()) {
        throw new Error("azd ai agent show returned an invalid agent instance identity.");
      }
      result.instance_identity = { principal_id: identity.principal_id };
    } else {
      result.instance_identity = {};
    }
  }
  return result;
}

export async function getActiveHostedAgentVersion(
  project: Pick<AzdProject, "capture" | "environment">,
  service: string,
): Promise<ActiveHostedAgentVersion> {
  return requireActiveVersion(await readHostedAgentVersion(project, service), service);
}

async function readHostedAgentVersion(
  project: Pick<AzdProject, "capture" | "environment">,
  service: string,
): Promise<HostedAgentVersion> {
  const active = parseHostedAgentVersion(
    await project.capture([
      "ai",
      "agent",
      "show",
      service,
      "--environment",
      project.environment,
      "--output",
      "json",
      "--no-prompt",
    ]),
  );
  return active;
}

function requireActiveVersion(
  active: HostedAgentVersion,
  service: string,
): ActiveHostedAgentVersion {
  if (active.status !== "active") {
    throw new Error(
      `Hosted agent '${service}' has deployment status '${active.status}', expected 'active'.`,
    );
  }
  const principalId = active.instance_identity?.principal_id?.trim();
  if (!principalId) {
    throw new Error(`Hosted agent '${service}' did not return an instance identity.`);
  }
  return { ...active, instance_identity: { principal_id: principalId } };
}

class HostedAgentPendingError extends Error {}

function hostedAgentReadiness(
  options: HostedAgentReadinessOptions = {},
): Required<HostedAgentReadinessOptions> {
  const attempts = options.attempts ?? 40;
  const delayMs = options.delayMs ?? 15_000;
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("Hosted agent readiness requires positive integer attempts and a non-negative delayMs.");
  }
  return { attempts, delayMs };
}

export async function waitForHostedAgentVersion(
  project: Pick<AzdProject, "capture" | "environment">,
  service: string,
  options: HostedAgentReadinessOptions = {},
): Promise<ActiveHostedAgentVersion> {
  const { attempts, delayMs } = hostedAgentReadiness(options);
  return retry(async () => {
    const version = await readHostedAgentVersion(project, service);
    if ([
      "pending", "queued", "creating", "provisioning", "starting",
      "activating", "updating", "deploying",
    ].includes(version.status)) {
      throw new HostedAgentPendingError(
        `Hosted agent '${service}' is not ready (status: '${version.status}').`,
      );
    }
    return requireActiveVersion(version, service);
  }, {
    attempts,
    delayMs,
    shouldRetry: (error) => error instanceof HostedAgentPendingError,
  });
}
