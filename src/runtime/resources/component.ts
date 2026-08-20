import { resolve } from "node:path";

import {
  deployAppServiceContainer,
  prepareAppServiceContainer,
} from "../../azure.js";
import type { Deployment } from "../../index.js";
import { deployHostedAgentResource } from "./hosted-agent.js";
import { deployTeamsApplicationResource } from "./teams.js";
import type { DeployResourceComponentOptions } from "./types.js";
import {
  normalizeImageName,
  resolveRuntimeSettings,
  resourceOutputName,
} from "./values.js";
import { enableResourceWorkflow } from "./workflows.js";

export async function deployResourceComponent(
  deployment: Deployment,
  options: DeployResourceComponentOptions,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const containerResources = options.resources.filter(
    (resource) => resource.kind === "container-host",
  );
  if (options.kind === "hosted-agent") {
    if (containerResources.length !== 1) {
      throw new Error(
        `Hosted agent component '${options.component}' requires exactly one container-host resource.`,
      );
    }
    Object.assign(
      values,
      await deployHostedAgentResource(
        deployment,
        options,
        containerResources[0]!,
      ),
    );
  } else {
    for (const resource of containerResources) {
      const service =
        containerResources.length === 1
          ? options.component
          : `${options.component}-${resource.id}`;
      const source = resource.source ?? options.source;
      if (!source) {
        throw new Error(
          `Container resource '${resource.id}' requires a component source directory.`,
        );
      }
      const resourceName =
        process.env[resourceOutputName(resource.id, "NAME")]?.trim();
      if (!resourceName && !deployment.dryRun) {
        throw new Error(
          `Provisioning output '${resourceOutputName(resource.id, "NAME")}' is missing.`,
        );
      }
      const serviceOptions = {
        directory: options.generatedDirectory,
        service,
        ...(resourceName ? { resourceName } : {}),
        project: resolve(options.packageDirectory, source),
        dockerfile: "Dockerfile",
        context: ".",
        registry: process.env.AZURE_CONTAINER_REGISTRY_ENDPOINT,
        imageName: normalizeImageName(service),
        remoteBuild: true,
        environment: resolveRuntimeSettings(resource, deployment.dryRun),
      } as const;
      if (deployment.dryRun) {
        await prepareAppServiceContainer(deployment, serviceOptions);
      }
      await deployment.deploy(
        `${options.component} container '${resource.id}'`,
        async () => {
          Object.assign(
            values,
            await deployAppServiceContainer(deployment, serviceOptions),
          );
        },
      );
    }
  }

  for (const resource of options.resources) {
    if (resource.kind === "teams-application") {
      Object.assign(
        values,
        await deployTeamsApplicationResource(deployment, options, resource),
      );
    } else if (resource.kind === "workflow-host") {
      await enableResourceWorkflow(deployment, options, resource);
    }
  }
  Object.assign(process.env, values);
  return values;
}