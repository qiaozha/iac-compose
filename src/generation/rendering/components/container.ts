import {
  asRecord,
  componentPathImports,
  componentProvisioningBlock,
  escapeTemplateLiteral,
  implementationOutputName,
  renderRuntimeValue,
  requiredString,
  stringArray,
} from "./helpers.js";
import type { ComponentSourceOptions } from "./options.js";
import type { ResourceRequirement } from "../../contracts/deployment.js";

export function renderContainerComponentSource(
  options: ComponentSourceOptions,
): string {
  const {
    component,
    functionName,
    source,
    resources,
    allResources,
    hasProvisioning,
    configureEntra,
  } = options;
  const containers = resources.filter(
    (candidate) =>
      candidate.kind === "container-host" &&
      candidate.requiredBy.includes(component),
  );
  if (containers.length !== 1) {
    throw new Error(
      `Component '${component}' requires exactly one container-host resource; found ${containers.length}.`,
    );
  }
  const resource = containers[0]!;
  const configuration = asRecord(resource.configuration);
  const runtimeSettings = asRecord(configuration.runtimeSettings);
  const ingress = asRecord(configuration.ingress);
  const ingressMode = ingress.mode === undefined
    ? Object.keys(ingress).length > 0 ? "restricted" : "unrestricted"
    : requiredString(
        ingress.mode,
        `${resource.id}.configuration.ingress.mode`,
      );
  if (
    ingressMode !== undefined &&
    ingressMode !== "restricted" &&
    ingressMode !== "unrestricted"
  ) {
    throw new Error(
      `${resource.id}.configuration.ingress.mode must be 'restricted' or 'unrestricted'.`,
    );
  }
  const ingressDefaultAction = ingressMode === "restricted"
    ? "Deny"
    : "Allow";
  const allowedServiceTags =
    ingress.allowedServiceTags === undefined
      ? []
      : stringArray(
          ingress.allowedServiceTags,
          `${resource.id}.configuration.ingress.allowedServiceTags`,
        );
  const privateEndpointTargets = allResources.flatMap((candidate) => {
    if (candidate.kind !== "container-host" || candidate.id === resource.id) {
      return [];
    }
    const candidateIngress = asRecord(
      asRecord(candidate.configuration).ingress,
    );
    const privateEndpoint = asRecord(candidateIngress.privateEndpoint);
    const sourceResourcesValue =
      privateEndpoint.sourceResources ?? candidateIngress.allowedSourceResources;
    const sourceResources =
      sourceResourcesValue === undefined
        ? []
        : stringArray(
            sourceResourcesValue,
            `${candidate.id}.configuration.ingress.privateEndpoint.sourceResources`,
          );
    if (!sourceResources.includes(resource.id)) return [];
    const publicServiceTags =
      candidateIngress.allowedServiceTags === undefined
        ? []
        : stringArray(
            candidateIngress.allowedServiceTags,
            `${candidate.id}.configuration.ingress.allowedServiceTags`,
          );
    return [{
      resource: candidate,
      publicNetworkAccess:
        publicServiceTags.length === 0 ? "Disabled" : "Enabled",
    }] as const;
  });
  const environmentEntries = Object.entries(runtimeSettings)
    .map(
      ([name, value]) =>
        `      ${JSON.stringify(name)}: ${renderRuntimeValue(value)},`,
    )
    .join("\n");
  const teamsApplications = resources.filter(
    (candidate) => candidate.kind === "teams-application",
  );
  if (teamsApplications.length > 1) {
    throw new Error(
      `Component '${component}' supports at most one teams-application resource; found ${teamsApplications.length}.`,
    );
  }
  const teamsBlock = teamsApplications[0]
    ? renderTeamsApplicationBlock(component, teamsApplications[0], source)
    : "";
  const teamsImport = teamsApplications.length === 1
    ? "\n  provisionTeamsApplication,"
    : "";
  const ingressImports = [
    ...(ingressDefaultAction ? ["  ensureAppServiceIngress,"] : []),
    ...(privateEndpointTargets.length > 0
      ? ["  ensureAppServicePrivateEndpoint,"]
      : []),
  ];
  const ingressImport =
    ingressImports.length > 0 ? `\n${ingressImports.join("\n")}` : "";
  const entraConfigurationImport = configureEntra
    ? 'import { configureEntraApplications } from "../shared/identity.js";\n'
    : "";
  const entraConfigurationBlock = configureEntra
    ? "  await configureEntraApplications(deployment);\n"
    : "";
  const serviceTagIngressBlock =
    ingressDefaultAction
      ? `  await deployment.deploy(${JSON.stringify(`configure ${component} ingress`)}, async () => {
    await ensureAppServiceIngress(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      siteName: requiredEnv(${JSON.stringify(implementationOutputName(resource.id, "NAME"))}),
      serviceTags: ${JSON.stringify(allowedServiceTags)},
      defaultAction: ${JSON.stringify(ingressDefaultAction)},
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
`
      : "";
  const privateEndpointBlock = privateEndpointTargets
    .map(
      ({ resource: target, publicNetworkAccess }) => `  await deployment.deploy(${JSON.stringify(`configure ${resource.id} private access to ${target.id}`)}, async () => {
    await ensureAppServicePrivateEndpoint(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      location: requiredEnv("AZURE_LOCATION"),
      sourceSiteName: requiredEnv(${JSON.stringify(implementationOutputName(resource.id, "NAME"))}),
      targetSiteName: requiredEnv(${JSON.stringify(implementationOutputName(target.id, "NAME"))}),
      sourceResourceName: ${JSON.stringify(resource.id)},
      targetResourceName: ${JSON.stringify(target.id)},
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      publicNetworkAccess: ${JSON.stringify(publicNetworkAccess)},
    });
  });
`,
    )
    .join("");
  const pathImports = componentPathImports(component, hasProvisioning, true);
  const provisioning = componentProvisioningBlock(
    component,
    hasProvisioning,
    false,
    resources,
  );
  return `import { resolve } from "node:path";

import {
  deployAppServiceContainer,${ingressImport}
  prepareAppServiceContainer,${teamsImport}
  type Deployment,
  waitForAppServiceReady,
} from "iac-compose";
import {
  persistEnvironment,
  requiredEnv,
} from "../../runtime/environment.js";
${entraConfigurationImport}import {
${pathImports}
} from "../../runtime/paths.js";

export async function ${functionName}(deployment: Deployment): Promise<void> {
  const outputs: Record<string, string> = {};
${provisioning}
${entraConfigurationBlock}${serviceTagIngressBlock}${privateEndpointBlock}  const service = {
    directory: generatedRoot,
    service: ${JSON.stringify(component)},
    ...(deployment.dryRun
      ? {}
      : { resourceName: requiredEnv(${JSON.stringify(implementationOutputName(resource.id, "NAME"))}) }),
    resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    project: resolve(packageRoot, ${JSON.stringify(resource.source ?? source ?? ".")}),
    dockerfile: "Dockerfile",
    context: ".",
    imageName: ${JSON.stringify(component)},
    remoteBuild: true,
    environment: {
${environmentEntries}
    },
  } as const;
  if (deployment.dryRun) await prepareAppServiceContainer(deployment, service);
  await deployment.deploy(${JSON.stringify(`${component} container '${resource.id}'`)}, async () => {
    Object.assign(outputs, await deployAppServiceContainer(deployment, service));
    await waitForAppServiceReady(deployment, {
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      siteName: requiredEnv(${JSON.stringify(implementationOutputName(resource.id, "NAME"))}),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    });
  });
${teamsBlock}
  await deployment.deploy("persist ${escapeTemplateLiteral(component)} deployment outputs", async () => {
    await persistEnvironment(deployment, outputs);
  });
}

function deploymentValue(deployment: Deployment, name: string): string {
  return deployment.dryRun ? "\${" + name + "}" : requiredEnv(name);
}
`;
}

function renderTeamsApplicationBlock(
  component: string,
  resource: ResourceRequirement,
  source: string | undefined,
): string {
  const configuration = asRecord(resource.configuration);
  const values = asRecord(configuration.manifestValues);
  const existingAppId = configuration.existingAppId;
  const teamId = configuration.teamId;
  if (
    existingAppId !== undefined &&
    (typeof existingAppId !== "string" || !existingAppId.trim())
  ) {
    throw new Error(
      `${resource.id}.configuration.existingAppId must be a non-empty string.`,
    );
  }
  if (
    teamId !== undefined &&
    (typeof teamId !== "string" || !teamId.trim())
  ) {
    throw new Error(
      `${resource.id}.configuration.teamId must be a non-empty string.`,
    );
  }
  const entries = Object.entries(values)
    .filter(([name]) => name !== "TEAMS_APP_ID")
    .map(
      ([name, value]) =>
        `        ${JSON.stringify(name)}: ${renderRuntimeValue(value)},`,
    )
    .join("\n");
  return `  Object.assign(
    outputs,
    await provisionTeamsApplication(deployment, {
      component: ${JSON.stringify(component)},
      componentDirectory: resolve(packageRoot, ${JSON.stringify(source ?? ".")}),
${existingAppId ? `      existingAppId: ${JSON.stringify(existingAppId)},\n` : ""}${teamId ? `      teamId: ${JSON.stringify(teamId)},\n` : ""}      manifestValues: {
${entries}
      },
      outputNames: ${JSON.stringify(resource.produces ?? [])},
    }),
  );`;
}