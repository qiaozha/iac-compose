import type {
  RenderedProvisioningFile,
  RenderResourceRequirementsOptions,
  ResourceContract,
} from "../../../shared/contracts/resources/types.js";
import { validateResourceContract } from "../../../shared/contracts/resources/validation.js";
import { renderResourceAccess } from "./access.js";
import { BicepRenderContext } from "./context.js";
import { renderRegistry } from "./infrastructure.js";
import { renderResource } from "./resources.js";
import {
  resourceCreateEnvironmentName,
  safeFileName,
} from "./syntax.js";

export function renderResourceRequirements(
  contract: ResourceContract,
  options: RenderResourceRequirementsOptions = {},
): readonly RenderedProvisioningFile[] {
  validateResourceContract(contract);
  const context = new BicepRenderContext(contract, options);
  context.sections.push(
    "targetScope = 'resourceGroup'",
    "",
    "param location string",
  );
  for (const resource of context.interactiveConnections()) {
    context.sections.push(
      "",
      `param ${context.connectionCreateParameter(resource)} bool`,
    );
  }
  context.sections.push(
    "",
    "var suffix = substring(uniqueString(resourceGroup().id), 0, 6)",
  );
  if (contract.resources.some((resource) => resource.kind === "container-host")) {
    renderRegistry(context);
  }
  for (const resource of contract.resources) renderResource(context, resource);
  for (const resource of contract.resources) {
    renderResourceAccess(context, resource);
  }
  context.renderOutputs();
  if (
    contract.resources.some(
      (resource) => resource.authentication === "managed-identity",
    )
  ) {
    context.sections.push(
      "",
      "extension 'br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:1.0.0'",
    );
  }

  const files: RenderedProvisioningFile[] = [
    {
      path: "main.bicep",
      contents: `${context.sections.join("\n")}\n`,
    },
    {
      path: "main.bicepparam",
      contents:
        "using './main.bicep'\n\n" +
        "param location = readEnvironmentVariable('AZURE_LOCATION', 'westus2')\n" +
        context.interactiveConnections()
          .map(
            (resource) =>
              `param ${context.connectionCreateParameter(resource)} = ` +
              `readEnvironmentVariable('${resourceCreateEnvironmentName(resource.id)}', 'true') == 'true'\n`,
          )
          .join(""),
    },
  ];
  for (const resource of contract.resources) {
    if (resource.kind !== "workflow-host") continue;
    const template = options.templates?.[resource.id];
    if (template === undefined) {
      throw new Error(
        `Workflow resource '${resource.id}' requires its source template during rendering.`,
      );
    }
    files.push({
      path: `templates/${safeFileName(resource.id)}.json`,
      contents: `${JSON.stringify(template, null, 2)}\n`,
    });
  }
  return files;
}