# azure-infrastructure

A separate Azure infrastructure intent-recognition and source-generation tool.
It owns workload analysis, Well-Architected service selection, the architecture
catalog, implementation contracts, contract-to-TypeScript generation, and
resource-plan access validation. It also owns resource contract types and the
legacy contract-driven adapters. It does not own the ordered IaC runtime.

Intent recognition is an agent workflow in the bundled
[azure-infrastructure-intent skill](.github/skills/azure-infrastructure-intent/SKILL.md).
The CLI deterministically generates source from an already selected plan;
there is no implicit AI inference in a `generate` command. Complete plans skip
intent recognition. Unsupported contract resources use direct IaC authoring.

Generated deployment programs depend only on [iac-composer](../../README.md)
and the Azure provisioning SDKs. Service lifecycles are emitted as customer-owned
TypeScript under `runtime/services/`, including hosted-agent deployment, API
connection authorization, configuration writes, and selected authorization
bootstrap operations. Each generated component imports the helper files it
uses and supplies its provisioning layer and runtime configuration.
Hosted-agent deployment returns its endpoint, identity, name, and version.
Applications that include a configuration store persist agent values in a
separate application deployment step.

Programmatic callers that still interpret resource contracts import
`ResourceContract`, `ResourceContractRequirement`, `deployResourceComponent`,
`prepareResourceRequirements`, and `resolveOutputBindings` from
`azure-infrastructure`, not `iac-composer`. These adapters translate contract
data into explicit deployment calls. Functions such as `deployHostedAgentService`,
`provisionTeamsApplication`, and `enableWorkflowDeployment` are bundled as source
templates and copied into generated deployment packages.

For hosted-agent containers, `configuration.hostedAgent` accepts `language`,
`startupCommand`, `cpu`, `memory`, `protocols`, and `docker` overrides. Docker
settings include `registry`, `path`, `context`, `image`, `tag`, and `remoteBuild`.
Existing plans retain their Python, responses-protocol, 0.5 CPU, and 1Gi
defaults; a different language uses the image's startup behavior unless the
plan supplies a startup command.

## Hosted-agent service lifecycle

`deployHostedAgentService` composes infrastructure provisioning, azd image
build/publish and deployment, readiness checks, and caller-selected access
assignments. Supply the provisioning entrypoint and the service's runtime
configuration:

```ts
import { defineDeployment, requiredEnv } from "iac-composer";
import { deployHostedAgentService } from "./runtime/services/hosted-agent.js";

export default defineDeployment(async (deployment) => {
  const result = await deployHostedAgentService(deployment, {
    service: "assistant",
    directory: ".generated",
    sourceDirectory: "./agent",
    provision: {
      entrypoint: "./infra.ts",
      outputDirectory: ".generated/assistant",
      scope: "resourceGroup",
      resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: requiredEnv("AZURE_LOCATION"),
    },
    configuration: (outputs) => ({
      name: deployment.dryRun ? "${AGENT_NAME}" : requiredEnv("AGENT_NAME", outputs),
      language: "dotnet",
      startupCommand: "dotnet Assistant.dll",
      container: { cpu: "1", memory: "2Gi" },
      protocols: [{ protocol: "responses", version: "2.0.0" }],
      docker: { registry: "${AZURE_CONTAINER_REGISTRY_ENDPOINT}" },
    }),
  });

  if (result.status === "deployed") {
    await deployment.env("publish assistant outputs", {
      ASSISTANT_ENDPOINT: result.endpoint,
      ASSISTANT_PRINCIPAL_ID: result.principalId,
    });
  }
});
```

In this example, the provisioning module exports `AGENT_NAME`,
`AZURE_AI_PROJECT_ID`, and `AZURE_CONTAINER_REGISTRY_ENDPOINT`. The configuration
factory runs after provisioning and receives its outputs. Language, container
resources, protocols, startup command, Docker paths, image tags, and environment
values are caller-controlled. Omitting `startupCommand` uses the image's startup
behavior.
An async configuration factory can compose application-specific preparation
steps after infrastructure provisioning and before the service deployment.

Use `provision` for new infrastructure or omit it when deploying to existing
infrastructure. `deploy.fromPackage` accepts an already-built image, while the
default source-backed flow delegates image build and publishing to azd.
`readiness` controls polling attempts and delay; defaults are 40 checks at
15-second intervals. Terminal states and command failures stop the lifecycle.

The result is discriminated by `status`: `"preview"` returns local compilation
results through `infrastructureOutputs`; `"deployed"` also returns
`deploymentOutputs`, the active `agent` version, `endpoint`, and `principalId`.
Applications compose subsequent configuration or deployment steps from these
outputs.

Use provisioning-library resources for persistent settings such as
[role assignments](https://learn.microsoft.com/azure/templates/microsoft.authorization/roleassignments)
and [App Configuration key-values](https://learn.microsoft.com/azure/templates/microsoft.appconfiguration/configurationstores/keyvalues),
as well as [workflow definitions and state](https://learn.microsoft.com/azure/logic-apps/logic-apps-azure-resource-manager-templates-overview).
Application-owned helpers support explicit post-provisioning operations, including
[OAuth connection authorization](https://learn.microsoft.com/azure/logic-apps/logic-apps-deploy-azure-resource-manager-templates#authorize-oauth-connections)
and [hosted-agent version and identity lookup](https://learn.microsoft.com/azure/foundry/agents/how-to/deploy-hosted-agent#deployment-lifecycle).
Role-grant calls require an identity already authorized to create assignments;
the caller chooses the roles and scope. App Configuration writes require the
appropriate data-plane role; use Key Vault references for secrets.

## Local development

Build the runtime first, then install and build this standalone package:

```bash
npm install
npm run build
npm install --prefix tools/azure-infrastructure
npm run --prefix tools/azure-infrastructure build
npm run --prefix tools/azure-infrastructure test
```

This package deliberately uses a local `iac-composer: file:../..` dependency
while it lives in this repository. To extract it into another repository,
replace that dependency with a published or explicitly pinned runtime package.
Generation resolves the installed runtime package rather than assuming a
sibling source tree. The provisioning SDK tarballs are owned and packaged here.

## Agent workflow

This is an optional architecture-recognition and contract-generation workflow.
The primary implementation discovery surface is
[iac-composer's own skill and MCP setup](../../agent-setup/README.md):
TypeScript provisioning-library resource definitions, helper APIs, and ordered
provisioning/deployment. It accepts requirements from any planner or the user
without requiring this package or converting the plan into this generator's
JSON formats.

Use this package when its planning capabilities or contract-to-code generator
are specifically wanted. Explicit tool choices and existing compatible IaC
take precedence. Keep authored contracts and source in the customer's repo.

The local `azure-infrastructure-mcp --workspace <consumer-repository>` stdio
server exposes:

- `azure_infrastructure_get_context`: read-only, focused intent workflow,
  resources, schemas, direct-authoring and runtime capabilities. The `start`
  topic explains the boundaries without loading all references or the catalog.
- `azure_infrastructure_generate`: deterministic local generation from existing
  resource-requirements and solution files, with workspace and file-ownership
  safeguards. It reuses the same generator as the CLI.

The server does not select services in code, execute authored modules, run
arbitrary commands, authenticate, validate Azure permissions, provision, grant
roles, or delete resources. It distinguishes generated source from deployment
readiness. See [the optional MCP integration](docs/mcp.md) for registration and
its distinction from the runtime-owned implementation tools.

`getAzureInfrastructureContext(topic)` provides the same context to programmatic
callers of this optional integration. The independent runtime owns its own
`iac-composer-mcp` server; it does not depend on these planner/generator tools.
Programmatic `generateDeploymentCode` callers can opt into the same
workspace/ownership preflight with `workspaceRoot`; existing CLI defaults remain
unchanged. Progress callbacks now identify each phase before its work, so
validation and rendering failures are attributed to the appropriate stage.
See the [implementation selection evaluation](../../agent-setup/evaluation/README.md)
to test choosing TypeScript/provisioning-library authoring without this planner.
Protocol and packaging tests alone do not prove model selection.

### Implementation contract

The intent skill writes `implementation-contract.json` as the stable,
customer-specific handoff to infrastructure generation. The generated IaC uses
iac-composer for execution. The current schema version is `1.0`.
The contract describes components, resources, authoring mode, configuration,
controls, outputs, dependencies, identity access, parameters, assumptions,
Well-Architected decisions, tradeoffs, validation gates, and unresolved
blockers.

Read the complete
[implementation contract schema reference](docs/implementation-contract.md),
the machine-readable
[JSON Schema](.github/skills/azure-infrastructure-intent/references/implementation-contract.schema.json),
and the validated
[contract-driven](docs/examples/implementation-contract.contract.json) and
[direct-authoring](docs/examples/implementation-contract.direct.json)
examples.

### Azure Architecture Center catalog

The intent skill includes a pinned, machine-readable
[Architecture Center catalog](.github/skills/azure-infrastructure-intent/references/architecture-catalog.json).
The current snapshot extracts all 194 `YamlMime:Architecture` examples from the
official MicrosoftDocs source, including categories, products, pinned content
paths, 25 explicitly linked implementation URLs across 17 examples, and a
preliminary iac-composer authoring route.

Refresh it from the official repository:

```bash
npm run --prefix tools/azure-infrastructure architecture:sync
```

The extractor resolves `main` to a commit, rejects incomplete GitHub tree
responses, and records the CC BY 4.0 documentation and MIT code licenses. Use
`GITHUB_TOKEN` only when a higher API rate limit is needed. The command can
also be called directly with another ref or destination:

```bash
azure-infrastructure architecture-catalog \
  --ref main \
  --output ./architecture-catalog.json
```

Catalog product identifiers are internal discovery metadata, not a deployable
resource graph. The intent skill privately matches workload capabilities to
proven patterns, reads the full pinned article, and emits only a
customer-specific `implementation-contract.json`. Catalog titles, IDs, URLs,
source commits, and sample links never enter that contract or generated
infrastructure. Explicitly requested provenance is reported separately. See the
[internal matching workflow](.github/skills/azure-infrastructure-intent/references/architecture-center-workflow.md),
the [implementation contract](docs/implementation-contract.md),
and
[implementation handoff workflow](.github/skills/azure-infrastructure-intent/references/implementation-contract-handoff.md).

## Validate deployment access

`azure-infrastructure validate` checks that every Azure resource provider used by the
generator is registered and that the deployment principal has the minimum
roles needed for generated data operations at the target scope:

```bash
azure-infrastructure validate \
  --resources ./package/config/resource-requirements.json \
  --subscription <subscription-id> \
  --resource-group <resource-group>
```

Validation covers providers declared by `azureResourceTypes` and providers the
generator adds implicitly. It requires `App Configuration Data Owner` for
generated key writes, `AcrPush` for component images, and `Foundry User`
when the solution deploys a hosted Foundry agent. Missing providers or roles
make the command fail. Add `--grant` to assign missing roles at the target scope:

```bash
azure-infrastructure validate \
  --resources ./package/config/resource-requirements.json \
  --resource-group <resource-group> \
  --grant
```

Use `--scope` instead of `--resource-group` for an explicit Azure resource ID.
Automation can pass `--principal-id` and `--principal-type ServicePrincipal`;
the equivalent environment variables are `AZURE_PRINCIPAL_ID` and
`AZURE_PRINCIPAL_TYPE`. Granting requires
`Microsoft.Authorization/roleAssignments/write` at the target scope.

Generated deployments use the same role plan. After ensuring the resource
group exists, the shared lifecycle grants any missing deployment-principal
roles before provisioning resources.

## Generate deployment code

`azure-infrastructure generate` turns a solution plan and its resource requirements into a
chatbot-style TypeScript deployment program:

```bash
azure-infrastructure generate \
  --resources ./package/config/generated/resource-requirements.json \
  --solution ./package/solution.json \
  --output ./package/deployment
```

The input files must use `schemaVersion` `1.0`. The generator validates that
the enabled components and planned resources agree, verifies every
`${output.<name>}` binding, and derives application deployment order from
bindings consumed by container, Teams, and workflow steps.

For managed-identity container applications, generation embeds the team's fixed
Service Tree ID (`c29c71f8-2db7-4d9e-bf8b-e6b0965ecde4`) directly in the Graph
application definition. It is not a source or environment input.

The generated source follows the same ownership layout as the chatbot example:

```text
deployment/
  package.json
  tsconfig.json
  deploy.ts
  components/
    shared/
      graph-provisioning.ts
      index.ts
      provisioning.ts
    <component>/
      index.ts
      provisioning.ts         # when the component owns Azure resources
      workflow.ts             # when the component owns a workflow
  runtime/
    environment.ts
    paths.ts
```

`deploy.ts` owns component order and selection. The input contracts are not
copied into the generated source. Resources required by exactly one component
are translated into that component's `provisioning.ts`; genuinely shared
resources remain under `components/shared/`. Each provisioning file contains
explicit `@azure/provisioning-*` constructors, parameters, outputs, and role
assignments, then renders those constructors to Bicep. Workflow ARM definitions
become editable TypeScript factories in component-local `workflow.ts` files.
Each component provisions and persists its infrastructure immediately before
its application lifecycle.
Container sources are deployed to generated App
Services through azd. Components whose solution kind is `hosted-agent` use the
`azure.ai.agent` target and receive their runtime identity and RBAC after the
active version is created. Teams manifest values are provisioned with Teams App
CLI using environment-specific state. Generated deployments execute the
component-authored `teamsapp.yml` from its source directory, matching the
chatbot lifecycle while supplying generated manifest values through an isolated
environment file. An interactive API connection must be authorized before its
generated Logic App is enabled.

Container resources with `authentication: "microsoft-entra"` receive an Entra
API application and App Service Easy Auth configuration. The nested
`configuration.authentication` contract defines the delegated permission scope
and authorized client application IDs used for Graph preauthorization and Easy
Auth enforcement. Provisioning those resources requires permission to create
Microsoft Graph applications and service principals in the target tenant.
Generated container ingress sets the App Service default action to `Deny` for
restricted policies and `Allow` for unrestricted policies, then adds any
declared service-tag and peer App Service allow rules.

Generated Azure AI accounts and their model deployment stages default to
`eastus`. Set `AZURE_AI_LOCATION` to override that region. The region contributes
to generated AI account and project names, allowing an existing deployment to
move regions without attempting to mutate an Azure resource's immutable
location.

The source generator currently translates these logical resource kinds:

- `ai-project`
- `model-deployment`
- `container-registry`
- `document-database`
- `object-storage`
- `configuration-store`
- `application-monitoring`
- `container-host`
- `bot-identity`
- `teams-application`
- `authorized-api-connection`
- `workflow-host`

Container sources must contain a `Dockerfile`. A workflow resource must point
to an ARM template inside the solution package; the generator translates its
definition and parameter bindings to provisioning-library TypeScript. Replace contract
placeholders such as `<teams-group-id>` before a real deployment. Infrastructure
creates placeholder workflows disabled; the lifecycle refuses to enable one
until all placeholder values are replaced.

Regeneration only removes files listed in
`deployment/.iac-composer-codegen.json`, preserving files created separately in
the output directory. Generated code can live outside this package's dependency
tree: `iac-composer` resolves its generated `iac-composer` imports to the running
CLI package. Directly importing or compiling generated source still requires an
`iac-composer` dependency in the customer package.

Import `generateDeploymentCode` from `azure-infrastructure`. Programmatic callers can observe generation phase boundaries without parsing
CLI text:

```ts
await generateDeploymentCode({
  resourcesFile,
  solutionFile,
  outputDirectory,
  onProgress: ({ stage, percent, message, componentCount, fileCount }) => {
    logger.info(message, { stage, percent, componentCount, fileCount });
  },
});
```

Generation reports `loadingInputs`, `validatingContracts`,
`planningComponents`, `renderingSources`, `writingFiles`, and `completed` in
order. The CLI renders the same events as `[azure-infrastructure] GENERATE` lines. The
callback may be asynchronous; if it rejects, generation stops and propagates
the error to the caller.

Install the generated package's provisioning SDK dependencies before typechecking
it directly:

```bash
npm install --prefix ./package/deployment
npm run --prefix ./package/deployment typecheck
```

Run or inspect the result with:

```bash
iac-composer ./package/deployment/deploy.ts --environment dev --dry-run
iac-composer ./package/deployment/deploy.ts --environment dev
iac-composer ./package/deployment/deploy.ts --environment dev --component frontend
```

`--dry-run` renders provisioning entrypoints and writes their generated Bicep,
parameter files, and one `.generated/azure.yaml`. It does not initialize azd
environments, run cloud commands, or execute application deployment callbacks.
Each provisioning component is a named Bicep layer whose files remain under
`.generated/<component>/`. `iac-composer` preserves authored lifecycle ordering by
running `azd provision <layer>` at each provisioning step. Infrastructure layers
and deployable services share the single `.generated/.azure` environment.
Generated runtime paths expose one `generated<Component>Layer` descriptor, so a
component passes only `layer` to `deployment.provision`. The descriptor derives
the standard `components/<component>/provisioning.ts` entrypoint and
`.generated/<component>` output directory from the component name. The two-phase
Entra lifecycle uses bootstrap and configuration descriptors that share the same
`identity` output layer but override the source entrypoint.
`getAzdProject` memoizes one `AzdProject` per deployment, generated root, and
environment. Environment state, infrastructure layers, and service manifests
configure that shared instance instead of constructing a project per component.

Delete all resources tracked by that generated project with:

```bash
iac-composer down ./package/deployment/.generated --environment dev --force
```

Cleanup requires an explicit environment, `--force`, and iac-composer ownership
metadata in `azure.yaml`; it refuses arbitrary azd project directories. Add
`--purge` to permanently remove resources that Azure otherwise soft-deletes.

`-C <directory>` changes the deployment working directory. A program can use
`deployment.inDirectory(...)` for a scoped child context.

`--component <name>` passes a deployment-defined component selector to the
program. Programs that support component selection can use it to run one
component while keeping their default full deployment unchanged.
