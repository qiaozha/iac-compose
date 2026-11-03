import type { ResourceRequirement } from "../../contracts/deployment.js";
import { microsoftEntraAuthentication } from "../identity/planning.js";
import { identifier, pascalCase } from "../names.js";
import { hasOutputBinding } from "../outputs.js";
import {
  arrayValue,
  asObject,
  requiredArray,
  requiredObject,
} from "../values.js";
import { collectWorkflowInputs } from "../workflows.js";
import type { RenderingContext } from "./context.js";
import {
  createResourceEnvironment,
  modelDeploymentName,
  workflowDeploymentEnvironment,
  workflowEnvironment,
} from "./helpers.js";

export function registerOutputs(context: RenderingContext): void {
  for (const resource of context.resources) {
    if (!context.owns(resource)) continue;
    const base = identifier(resource.id);
    const lifecycleOutput =
      context.owner !== undefined &&
      (resource.kind === "teams-application" || context.isHosted(resource));
    if (lifecycleOutput) continue;
    for (const output of resource.produces ?? []) {
      context.outputs.set(output, outputExpression(context, resource, output, base));
    }
    if (resource.kind === "authorized-api-connection") {
      const parameterName = `create${pascalCase(resource.id)}`;
      context.parameters.push(
        `const ${parameterName} = stack.parameters.add(${JSON.stringify(parameterName)}, "bool");`,
      );
      context.parameterBindings.push(
        `${parameterName}: fn.eq(\n      fn.readEnvironmentVariable(${JSON.stringify(createResourceEnvironment(resource.id))}, "true"),\n      "true",\n    )`,
      );
    }
  }
}

function outputExpression(
  context: RenderingContext,
  resource: ResourceRequirement,
  output: string,
  base: string,
): string {
  if (resource.kind === "workflow-host" && /IdentityPrincipalId$/i.test(output)) {
    const identity = `(${base} as any).identity.principalId as any`;
    const deploymentCondition = context.workflowDeploymentCondition(resource);
    return deploymentCondition
      ? `fn.cond(${deploymentCondition}, ${identity}, "") as any`
      : identity;
  }
  const expressions: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "ai-project": {
      foundryProjectEndpoint: `fn.concat("https://", ${base}Account.name, ".services.ai.azure.com/api/projects/", ${base}Project.name)`,
      agentName: JSON.stringify(`${context.solutionName()}-agent`),
      agentVersion: context.hasHostedAgent() ? JSON.stringify("") : JSON.stringify("1"),
    },
    "document-database": {
      cosmosEndpoint: `${base}Account.properties.documentEndpoint as any`,
      cosmosDatabase: `${base}Database.name`,
      cosmosAccountName: `${base}Account.name`,
      cosmosAccountResourceId: `${base}Account.id`,
    },
    "object-storage": {
      storageBlobEndpoint: `${base}Account.properties.primaryEndpoints!.blob as any`,
      storageAccountName: `${base}Account.name`,
      storageAccountResourceId: `${base}Account.id`,
    },
    "configuration-store": {
      appConfigurationEndpoint: `${base}Store.properties.endpoint as any`,
      appConfigurationName: `${base}Store.name`,
      appConfigurationResourceId: `${base}Store.id`,
    },
    "application-monitoring": {
      applicationInsightsConnectionString: `${base}Insights.properties.ConnectionString as any`,
      applicationInsightsName: `${base}Insights.name`,
    },
    "model-deployment": {
      foundryModelDeploymentName: JSON.stringify(modelDeploymentName(resource)),
    },
    "container-registry": {
      containerRegistryName: "deploymentRegistry.name",
      containerRegistryEndpoint: "deploymentRegistry.properties.loginServer as any",
    },
    "container-host": containerOutputExpressions(context, resource, base),
    "bot-identity": {
      botClientId: `${base}Identity.properties.clientId as any`,
      botIdentityPrincipalId: `${base}Identity.properties.principalId as any`,
      botIdentityResourceId: `${base}Identity.id`,
      tenantId: `${base}Identity.properties.tenantId as any`,
    },
    "teams-application": {
      teamsAppId: `fn.guid(fn.subscription().subscriptionId, fn.resourceGroup().id, ${JSON.stringify(resource.id)})`,
    },
    "authorized-api-connection": {
      teamsConnectionResourceId: `fn.resourceId("Microsoft.Web/connections", "teams")`,
      connectionResourceId: `fn.resourceId("Microsoft.Web/connections", "teams")`,
    },
  };
  const expression = expressions[resource.kind]?.[output];
  if (!expression) {
    throw new Error(
      `Resource '${resource.id}' of kind '${resource.kind}' cannot produce '${output}'.`,
    );
  }
  return expression;
}

function containerOutputExpressions(
  context: RenderingContext,
  resource: ResourceRequirement,
  base: string,
): Readonly<Record<string, string>> {
  if (context.isHosted(resource)) {
    return {
      agentEndpoint: JSON.stringify(""),
      agentIdentityClientId: JSON.stringify(""),
      agentIdentityPrincipalId: JSON.stringify(""),
      agentIdentityResourceId: JSON.stringify(""),
    };
  }
  return {
    agentEndpoint: `fn.concat("https://", ${base}Site.properties.defaultHostName as any)`,
    agentIdentityClientId: `${base}Identity.properties.clientId as any`,
    agentIdentityPrincipalId: `${base}Identity.properties.principalId as any`,
    agentIdentityResourceId: `${base}Identity.id`,
    backendBaseUrl: `fn.concat("https://", ${base}Site.properties.defaultHostName as any)`,
    backendAudience:
      microsoftEntraAuthentication(resource)
        ? `${base}Audience`
        : `${base}Identity.properties.clientId as any`,
    backendIdentityClientId: `${base}Identity.properties.clientId as any`,
    backendIdentityPrincipalId: `${base}Identity.properties.principalId as any`,
    backendIdentityResourceId: `${base}Identity.id`,
    frontendBaseUrl: `fn.concat("https://", ${base}Site.properties.defaultHostName as any)`,
    frontendIdentityClientId: `${base}Identity.properties.clientId as any`,
    frontendIdentityPrincipalId: `${base}Identity.properties.principalId as any`,
    frontendIdentityResourceId: `${base}Identity.id`,
  };
}

export function prepareWorkflowPlans(context: RenderingContext): void {
  for (const resource of context.ofKind("workflow-host")) {
    const template = requiredObject(
      context.options.templates[resource.id],
      `Workflow template '${resource.id}'`,
    );
    const templateResource = requiredObject(
      requiredArray(template.resources, `${resource.id}.resources`)[0],
      `${resource.id}.resources[0]`,
    );
    const definition = requiredObject(
      requiredObject(templateResource.properties, `${resource.id}.properties`).definition,
      `${resource.id}.definition`,
    );
    const templateParameters = asObject(template.parameters);
    const configuredParameters = asObject(asObject(resource.parameters).parameters);
    const expressions = new Map<string, string>();
    const declarations: string[] = [];
    const bindings: string[] = [];
    const deploymentCondition = context.workflowDeploymentCondition(resource);
    if (deploymentCondition) {
      context.parameters.push(
        `const ${deploymentCondition} = stack.parameters.add(${JSON.stringify(deploymentCondition)}, "bool");`,
      );
      context.parameterBindings.push(
        `${deploymentCondition}: fn.eq(\n      fn.readEnvironmentVariable(${JSON.stringify(workflowDeploymentEnvironment(resource.id))}, "false"),\n      "true",\n    )`,
      );
    }
    for (const name of collectWorkflowInputs(definition)) {
      const configured = asObject(configuredParameters[name]).value;
      if (configured === undefined) {
        throw new Error(`Workflow '${resource.id}' parameter '${name}' is not configured.`);
      }
      if (hasOutputBinding(configured)) {
        expressions.set(name, context.renderValue(configured));
        continue;
      }
      const variable = `${identifier(resource.id)}${pascalCase(name)}`;
      const parameterType = String(asObject(templateParameters[name]).type ?? "string").toLowerCase();
      if (parameterType === "array") {
        declarations.push(
          `const ${variable} = stack.parameters.add(${JSON.stringify(variable)}, "string");`,
        );
        expressions.set(name, `fn.split(${variable}, ",")`);
        bindings.push(
          `${variable}: fn.readEnvironmentVariable(${JSON.stringify(workflowEnvironment(resource.id, name))}, ${JSON.stringify(arrayValue(configured).join(","))})`,
        );
      } else {
        declarations.push(
          `const ${variable} = stack.parameters.add(${JSON.stringify(variable)}, "string");`,
        );
        expressions.set(name, variable);
        bindings.push(
          `${variable}: fn.readEnvironmentVariable(${JSON.stringify(workflowEnvironment(resource.id, name))}, ${JSON.stringify(String(configured))})`,
        );
      }
    }
    context.workflowPlans.push({
      resource,
      definition,
      templateParameters,
      functionName: `create${pascalCase(resource.id)}Definition`,
      importPath:
        context.owner === undefined
          ? `../${resource.requiredBy[0] ?? "workflow"}/workflow.js`
          : "./workflow.js",
      ...(deploymentCondition ? { deploymentCondition } : {}),
      parameterExpressions: expressions,
      parameterDeclarations: declarations,
      parameterBindings: bindings,
    });
    context.parameters.push(...declarations);
  }
}