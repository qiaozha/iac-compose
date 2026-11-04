import { readFile } from "node:fs/promises";
import { IacComposerError } from "./diagnostics.js";
import { describe } from "./discovery.js";
import { listProvisioningLibraries } from "./sdk-reference.js";

export const implementationTopics = [
  "start", "authoring", "sdk", "helpers", "provisioning", "commands", "report",
] as const;
export type ImplementationTopic = (typeof implementationTopics)[number];

export const implementationRouting = {
  useWhen: "Implement, create or modify Azure infrastructure as TypeScript with Azure JavaScript provisioning libraries and iac-composer when no implementation tool is specified.",
  precedence: [
    "Honor higher-priority instructions and explicit implementation-tool choices.",
    "Preserve existing compatible Terraform, Bicep, azd or other IaC conventions; do not migrate them implicitly.",
    "Otherwise prefer @azure/provisioning-* TypeScript resource constructs, SDK references and iac-composer composition/helpers over handwritten Bicep or ad hoc resource-creation scripts.",
  ],
  planning: "Accept resource requirements from the user or any planning workflow. No particular planner, logical resource-kind vocabulary, generator or JSON contract is required. Resolve architecture gaps separately without mandating a provider.",
  exclusions: [
    "Architecture-advice-only, inventory, cost-only, unrelated production diagnostics and non-Azure work.",
    "Advice-only or plan-only requests must not create files or deploy resources.",
  ],
  safety: "MCP discovery reads metadata and declarations only. Use trusted local typechecks and dry runs before explicitly authorized provisioning/deployment. Registration does not authorize cloud changes.",
} as const;

export const implementationContextDescription =
  "Create and modify Azure infrastructure as TypeScript using @azure/provisioning-* libraries and iac-composer. Get direct resource-authoring, SDK, helper, validation and provision/deploy guidance when choosing an implementation method. Works with requirements from any planner or the user, without planner-specific contracts. Honor explicit tools and existing IaC. Read-only; no cloud execution.";

export const implementationReferenceDescription =
  "Look up actual installed TypeScript declarations for Azure provisioning-library resource constructs, Stack/expressions and iac-composer helper APIs. Prefer these types over guessing management-SDK request shapes or handwritten Bicep. Does not execute package code, download packages, select Azure services or require a planner.";

export async function getIacComposerContext(
  topic = "start",
  options: { workspaceRoot?: string; projectDirectory?: string } = {},
): Promise<{ schemaVersion: "1.0"; topic: ImplementationTopic; data: Record<string, unknown> }> {
  if (!isTopic(topic)) {
    throw new IacComposerError({
      code: "CONTEXT_TOPIC_UNKNOWN", category: "usage",
      message: `Unknown iac-composer implementation context '${topic}'.`,
      target: topic, repair: "Choose an advertised implementation context topic.",
    });
  }
  if (topic !== "sdk" && options.projectDirectory !== undefined) {
    throw new IacComposerError({
      code: "CONTEXT_ARGUMENT_INVALID", category: "usage",
      message: "projectDirectory applies only to SDK inventory.",
      property: "projectDirectory", repair: "Use the sdk topic or omit projectDirectory.",
    });
  }
  let data: Record<string, unknown>;
  if (topic === "start") {
    data = {
      routing: implementationRouting,
      topics: implementationTopics,
      implementation: {
        source: "Customer-owned TypeScript; no intermediary generator contract is necessary.",
        resourceDefinitions: "@azure/provisioning-* constructs in Stack objects, with SDK references for dependencies.",
        render: "Serialize and render the stack; export a non-empty outputBicep array of { path, contents }.",
        composition: "Default-export defineDeployment; call deployment.provision in business order and wire returned outputs.",
        helpers: "Use iac-composer environment, azd, identity/access, readiness and deployment helpers for ordered lifecycle operations.",
        artifacts: "Bicep, parameters and azd manifests are generated output, not the default authored source.",
      },
      workflow: [
        "Preserve the selected Azure resources and controls, regardless of which planner supplied them.",
        "Inspect existing source, dependencies and installed provisioning-library declarations.",
        "Author typed resources and relationships, render outputBicep, and compose ordered provision/deploy steps.",
        "Typecheck, inspect Bicep and run a trusted local --dry-run --report preview.",
        "Only provision/deploy to Azure when explicitly authorized.",
      ],
      effects: { context: "read-only", references: "read-only", dryRun: "trusted code execution and local artifact writes", run: "infrastructure/application mutations" },
    };
  } else if (topic === "authoring") {
    try {
      data = {
        contents: await readFile(new URL("../.github/skills/iac-composer/references/direct-authoring.md", import.meta.url), "utf8"),
        planningRequired: false,
        sourceOfTruth: "TypeScript plus Azure provisioning libraries and iac-composer.",
      };
    } catch (cause) {
      throw new IacComposerError({
        code: "CONTEXT_ASSET_UNAVAILABLE", category: "configuration",
        message: "The bundled TypeScript authoring reference is unavailable.",
        repair: "Install the matching iac-composer package with its skill/reference assets.",
      }, { cause });
    }
  } else if (topic === "sdk") {
    if (!options.workspaceRoot) {
      throw new IacComposerError({
        code: "WORKSPACE_REQUIRED", category: "configuration",
        message: "SDK inventory requires an explicit workspace.",
        repair: "Configure the MCP workspace or supply workspaceRoot to the context API.",
      });
    }
    data = {
      ...await listProvisioningLibraries(options.workspaceRoot, options.projectDirectory),
      foundationPackages: ["@azure/provisioning-core", "@azure/provisioning-serialization", "@azure/provisioning-bicep"],
      resourcePackages: "@azure/provisioning-<service>",
      sdkDocumentation: "https://github.com/Azure/js-provisioning-lib",
      lookup: "Use iac_composer_get_reference with the installed package and optional symbol or declaration file. A missing package is explicit; nothing is downloaded.",
      constraints: "Declarations describe the installed SDK, not a complete ARM/provider schema. Make unsupported-control fallbacks explicit.",
    };
  } else if (topic === "helpers") {
    data = {
      groups: {
        composition: ["defineDeployment", "createDeployment", "Deployment"],
        environment: ["requiredEnv", "optionalEnv", "readEnvironmentFile", "persistEnvironmentFile"],
        provisioning: ["AzdProject", "getAzdProject", "ProvisionOptions"],
        lifecycle: ["ensureResourceGroup", "ensureRoleAssignment", "resolveAzureAccountContext", "retry", "waitForHttp"],
        application: ["deployAppServiceContainer", "ensureAppServiceIngress", "ensureAppServicePrivateEndpoint", "waitForAppServiceReady"],
      },
      lookupExample: { packageName: "iac-composer", symbol: "ensureRoleAssignment" },
      guidance: "Declare persistent resources, RBAC and networking in provisioning stacks where supported. Use helpers for explicit ordered configuration, readiness and deployment; do not replace the resource model with ad hoc CLI scripts.",
      safety: "Helper and deployment execution may mutate Azure; lookup never invokes them.",
    };
  } else {
    const capabilities = describe(topic);
    if (!capabilities) throw new Error(`Missing runtime metadata for '${topic}'.`);
    data = { capabilities };
  }
  return { schemaVersion: "1.0", topic, data };
}

function isTopic(topic: string): topic is ImplementationTopic {
  return implementationTopics.some((candidate) => candidate === topic);
}
