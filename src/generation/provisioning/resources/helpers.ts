import type { ResourceRequirement } from "../../contracts/deployment.js";
import {
  arrayValue,
  asObject,
  requiredObject,
  requiredString,
  stringValue,
} from "../values.js";

export function accessValues(resource: ResourceRequirement): Array<{
  principalOutput: string;
  role: string;
}> {
  return arrayValue(resource.access).map((value, index) => {
    const access = requiredObject(value, `${resource.id}.access[${index}]`);
    return {
      principalOutput: requiredString(
        access.principalOutput,
        `${resource.id}.access[${index}].principalOutput`,
      ),
      role: requiredString(access.role, `${resource.id}.access[${index}].role`),
    };
  });
}

export function modelDeploymentName(resource: ResourceRequirement): string {
  const configuration = asObject(resource.configuration);
  return stringValue(
    configuration.deploymentName,
    stringValue(configuration.model, resource.id),
  );
}

export function defaultModelVersion(): string {
  return "2025-04-14";
}

export function createResourceEnvironment(resourceId: string): string {
  return `DEPLOY_CREATE_RESOURCE_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

export function workflowEnvironment(
  resourceId: string,
  parameter: string,
): string {
  return `DEPLOY_WORKFLOW_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_${parameter.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

export function workflowDeploymentEnvironment(resourceId: string): string {
  return `DEPLOY_WORKFLOW_${resourceId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}