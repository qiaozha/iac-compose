import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeRuntimeCapabilities, IacComposerError } from "iac-composer";
import { supportedResourceKinds } from "./validation/resources/plan.js";

export const contextTopics = [
  "start",
  "intent",
  "intent-model",
  "service-selection",
  "well-architected",
  "architecture-workflow",
  "architecture-catalog",
  "resources",
  "contract",
  "contract-workflow",
  "schema",
  "direct-authoring",
  "runtime",
  "runtime-commands",
  "runtime-provisioning",
  "runtime-report",
] as const;

export type InfrastructureContextTopic = (typeof contextTopics)[number];

export const azureInfrastructureRouting = {
  useWhen: "Use this optional Azure intent-recognition workflow when architecture planning is needed or this contract-to-code generator has been chosen.",
  precedence: [
    "Honor higher-priority instructions and explicit user tool choices.",
    "Preserve existing compatible Terraform, Bicep, azd, or other IaC conventions; do not migrate them implicitly.",
    "Implement Azure resources with iac-composer TypeScript and provisioning libraries independently of which planner supplied the requirements.",
    "Use this tool's JSON contracts only when its generator is chosen, not as a prerequisite for implementation.",
  ],
  exclusions: [
    "Non-Azure and non-infrastructure work.",
    "Resource inventory, cost-only questions, and unrelated production diagnostics.",
    "Advice-only or plan-only requests must not generate files or execute infrastructure.",
  ],
  safety: "Generate and validate locally by default. Discovery and local generation do not authorize deployment, authentication, role grants, deletion, or arbitrary commands.",
} as const;

export const infrastructureContextDescription =
  "Get context for the optional azure-infrastructure architecture planner or its explicitly selected contract-to-code generator. Not required for direct TypeScript provisioning-library authoring with iac-composer, which accepts requirements from any planner or the user. Read-only; no cloud execution.";

export const infrastructureGenerationDescription =
  "Generate local TypeScript infrastructure and an iac-composer deployment from explicitly selected resource-requirements and solution JSON files. Writes generator-owned source inside the registered workspace. Does not select services, deploy to Azure, grant roles, authenticate, or run authored code. Use context first if the resource plan is incomplete.";

const skillRoot = new URL(
  "../.github/skills/azure-infrastructure-intent/",
  import.meta.url,
);
const references: Partial<Record<InfrastructureContextTopic, string>> = {
  intent: "SKILL.md",
  "intent-model": "references/intent-model.md",
  "service-selection": "references/service-selection.md",
  "well-architected": "references/well-architected-baseline.md",
  "architecture-workflow": "references/architecture-center-workflow.md",
  contract: "references/implementation-contract-handoff.md",
  "contract-workflow": "references/contract-workflow.md",
  schema: "references/implementation-contract.schema.json",
};

export interface InfrastructureContext {
  schemaVersion: "1.0";
  topic: InfrastructureContextTopic;
  data: Record<string, unknown>;
}

export async function getAzureInfrastructureContext(
  topic = "start",
  options: { query?: string; limit?: number } = {},
): Promise<InfrastructureContext> {
  if (!isContextTopic(topic)) {
    throw contextError("CONTEXT_TOPIC_UNKNOWN", topic, "Choose one of the advertised context topics.");
  }
  if (topic !== "architecture-catalog" && (options.query !== undefined || options.limit !== undefined)) {
    throw contextError("CONTEXT_ARGUMENT_INVALID", topic, "query and limit are only valid for architecture-catalog.");
  }
  let data: Record<string, unknown>;
  if (topic === "start") {
    data = {
      routing: azureInfrastructureRouting,
      topics: contextTopics,
      workflow: [
        { condition: "Incomplete resource plan", next: "intent", action: "Inspect the application and select the smallest suitable Azure resource plan." },
        { condition: "Complete plan and this generator is chosen", next: "contract-workflow", action: "Preserve the plan; prepare this generator's resource requirements and solution JSON, then generate locally." },
        { condition: "Direct resource implementation", next: "direct-authoring", action: "Use iac-composer with TypeScript provisioning libraries; do not require this planner or convert requirements to its contracts." },
        { condition: "Unsupported generator resource or control", next: "direct-authoring", action: "Keep the selected architecture and author provisioning SDK source directly." },
        { condition: "Existing iac-composer program", next: "runtime", action: "Modify or preview the existing authored program; do not re-plan its architecture." },
      ],
      boundaries: {
        planning: "Agent workflow, not implicit AI inference inside a CLI or MCP handler.",
        generation: "azure-infrastructure produces customer-owned source from selected plan files.",
        execution: "iac-composer runs authored lifecycle order; its dry run compiles local artifacts and skips wrapped actions.",
      },
      generationInputs: ["resourcesFile", "solutionFile", "outputDirectory"],
      implementationContract: "Planning handoff only; translate it into the two generator inputs, or use direct authoring.",
      effects: { context: "read-only", generate: "local generated-source writes", cloud: "not exposed by this server" },
    };
  } else if (topic === "resources") {
    data = {
      kinds: supportedResourceKinds(),
      inputSchemaVersion: "1.0",
      detailsTopic: "contract-workflow",
      implementationSchemaTopic: "schema",
      limitations: [
        "Only use output names and controls supported by the selected generator kind.",
        "Ordinary generated application components require exactly one container-host. Use direct authoring for infrastructure-only plans rather than adding unnecessary compute.",
        "Direct provisioning SDK authoring is not limited to this logical resource-kind list.",
        "Provider/access checks and cloud deployment are separate from local generation.",
      ],
    };
  } else if (topic === "architecture-catalog") {
    data = await queryCatalog(options);
  } else if (topic === "direct-authoring") {
    const root = resolve(dirname(fileURLToPath(import.meta.resolve("iac-composer"))), "..");
    data = {
      contents: await readAsset(
        pathToFileURL(resolve(root, ".github/skills/iac-composer/references/direct-authoring.md")),
        topic,
      ),
      note: "Preserve the selected resource plan. Local dry runs execute trusted provisioning modules and compilers; they are not a sandbox.",
    };
  } else if (topic === "runtime" || topic.startsWith("runtime-")) {
    const runtimeTopic = topic === "runtime" ? "overview" : topic.slice("runtime-".length);
    const capabilities = describeRuntimeCapabilities(runtimeTopic);
    if (!capabilities) {
      throw contextError("RUNTIME_CONTEXT_UNAVAILABLE", topic, "Install the matching pinned iac-composer runtime.");
    }
    data = { capabilities };
  } else {
    const reference = references[topic];
    if (!reference) {
      throw contextError("CONTEXT_TOPIC_UNKNOWN", topic, "Choose one of the advertised context topics.");
    }
    const contents = await readAsset(new URL(reference, skillRoot), topic);
    data = topic === "schema"
      ? { schema: parseObject(contents, topic) }
      : { source: reference, contents, references };
  }
  return { schemaVersion: "1.0", topic, data };
}

function isContextTopic(topic: string): topic is InfrastructureContextTopic {
  return contextTopics.some((candidate) => candidate === topic);
}

function contextError(code: string, target: string, repair: string): IacComposerError {
  return new IacComposerError({
    code,
    category: "configuration",
    message: `Azure infrastructure context is unavailable for '${target}'.`,
    target,
    repair,
  });
}

async function readAsset(url: URL, topic: string): Promise<string> {
  try {
    return await readFile(url, "utf8");
  } catch (cause) {
    throw new IacComposerError({
      code: "CONTEXT_ASSET_UNAVAILABLE",
      category: "configuration",
      message: `The bundled '${topic}' reference could not be read.`,
      target: topic,
      repair: "Install or build the matching pinned toolchain with its complete skill/reference assets.",
    }, { cause });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(contents: string, topic: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (cause) {
    throw new IacComposerError({
      code: "CONTEXT_ASSET_INVALID",
      category: "configuration",
      message: `The bundled '${topic}' reference is not valid JSON.`,
      target: topic,
      repair: "Reinstall the pinned toolchain; do not patch generated or installed reference files.",
    }, { cause });
  }
  if (!isObject(value)) {
    throw contextError("CONTEXT_ASSET_INVALID", topic, "Reinstall the matching reference assets.");
  }
  return value;
}

interface CatalogEntry {
  id: string;
  title: string;
  summary: string;
  url: string;
  sourceUrl: string;
  contentSourceUrl?: string;
  products: string[];
  categories: string[];
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  return isObject(value) &&
    ["id", "title", "summary", "url", "sourceUrl"].every((key) => typeof value[key] === "string") &&
    (value.contentSourceUrl === undefined || typeof value.contentSourceUrl === "string") &&
    Array.isArray(value.products) && value.products.every((entry) => typeof entry === "string") &&
    Array.isArray(value.categories) && value.categories.every((entry) => typeof entry === "string");
}

async function queryCatalog(options: { query?: string; limit?: number }): Promise<Record<string, unknown>> {
  const query = options.query?.trim();
  const limit = options.limit ?? 5;
  if (!query || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw contextError("CONTEXT_ARGUMENT_INVALID", "architecture-catalog", "Provide a query of 1-200 characters and a limit of 1-10.");
  }
  const catalog = parseObject(await readAsset(
    new URL("references/architecture-catalog.json", skillRoot), "architecture-catalog",
  ), "architecture-catalog");
  if (!Array.isArray(catalog.architectures) || !catalog.architectures.every(isCatalogEntry) ||
      !isObject(catalog.source) || typeof catalog.source.commit !== "string") {
    throw contextError("CONTEXT_ASSET_INVALID", "architecture-catalog", "Reinstall the matching pinned catalog.");
  }
  const words = query.toLowerCase().split(/\s+/);
  const matches = catalog.architectures.map((entry) => {
    const text = `${entry.title} ${entry.summary} ${entry.products.join(" ")} ${entry.categories.join(" ")}`.toLowerCase();
    return { entry, score: words.filter((word) => text.includes(word)).length };
  }).filter(({ score }) => score > 0).sort((left, right) =>
    right.score - left.score || (left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0),
  );
  return {
    query,
    sourceCommit: catalog.source.commit,
    matches: matches.length,
    results: matches.slice(0, limit).map(({ entry }) => ({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      url: entry.url,
      sourceUrl: entry.contentSourceUrl ?? entry.sourceUrl,
      products: entry.products,
      categories: entry.categories,
    })),
    constraint: "Private decision support, not a deployable plan. Read full pinned content before adoption; keep catalog provenance out of the customer implementation contract.",
  };
}
