# iac-compose

`iac-compose` runs TypeScript or JavaScript deployment programs in authored order.
Customer deployment programs do not need an azd project or azd hooks.

The runtime requires Node.js 20.6 or newer and generates isolated, hook-free azd
projects as an implementation detail. It compiles JavaScript provisioning output
into Bicep, delegates resource
deployment to `azd provision`, and exposes `AzdProject` for `azd deploy` service
targets while JavaScript retains lifecycle ordering.

```ts
import { defineDeployment } from "iac-compose";

export default defineDeployment(async (deployment) => {
  const outputs = await deployment.provision("infrastructure", {
    entrypoint: "./infra.ts",
    location: "westus2",
  });

  await deployment.deploy("API", async () => {
    await deployment.execute({
      command: "az",
      args: ["webapp", "deploy", "--name", outputs.API_NAME],
    });
  });
});
```

## Agent skills

This repository includes two complementary Agent Skills:

- [azure-infrastructure-intent](.github/skills/azure-infrastructure-intent/SKILL.md)
  infers resource requirements from a sparse workload request or application
  repository, applies Azure Well-Architected guidance, selects a cost-conscious
  architecture, and emits a customer-specific implementation contract.
- [iac-compose](.github/skills/iac-compose/SKILL.md) turns the selected
  architecture into contract-generated or directly authored TypeScript
  infrastructure with ordered lifecycle, validation, and deployment safety.

Install both for the intent-to-infrastructure workflow. Preview and install
them from this repository with GitHub CLI 2.90.0 or newer:

```bash
gh skill preview qiaozha/iac-compose azure-infrastructure-intent --allow-hidden-dirs
gh skill preview qiaozha/iac-compose iac-compose --allow-hidden-dirs
gh skill install qiaozha/iac-compose azure-infrastructure-intent --allow-hidden-dirs
gh skill install qiaozha/iac-compose iac-compose --allow-hidden-dirs
```

By default, GitHub CLI installs the skill for Copilot at project scope.

### Implementation contract

The intent skill writes `implementation-contract.json` as the stable,
customer-specific handoff to iac-compose. The current schema version is `1.0`.
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
preliminary iac-compose authoring route.

Refresh it from the official repository:

```bash
npm run architecture:sync
```

The extractor resolves `main` to a commit, rejects incomplete GitHub tree
responses, and records the CC BY 4.0 documentation and MIT code licenses. Use
`GITHUB_TOKEN` only when a higher API rate limit is needed. The command can
also be called directly with another ref or destination:

```bash
iac-compose architecture-catalog \
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
[iac-compose handoff workflow](.github/skills/iac-compose/references/implementation-contract-handoff.md).

### Evaluate the skills with Vally

The behavioral suites under [evals/](evals/) use
[Vally](https://aka.ms/vally) to measure skill routing, sparse Azure intent
recognition, Well-Architected service selection, contract generation, direct
TypeScript authoring, lifecycle ordering, cloud-operation safety, private
reference-pattern matching, implementation-contract privacy, and the end-to-end
handoff from inferred intent to final `iac-compose` infrastructure.

Vally requires Node.js 22.12 or newer and a GitHub account with an active
Copilot subscription. Validate the skill definitions and eval specifications
without invoking an agent:

```bash
npm run eval:lint
```

For reproducible behavioral evaluations, provide a fine-grained GitHub token
with **Copilot Requests** account permission. Vally then uses an isolated
Copilot configuration home containing only the skills declared by each eval:

```bash
export COPILOT_GITHUB_TOKEN="<token>"
npm run eval:routing
```

The routing suite is the smaller critical gate. Run every scenario with
`npm run eval:skills`, or run one skill suite with `npm run eval:intent` or
`npm run eval:iac-compose`. Run only the cross-skill final-outcome scenario with
`npm run eval:end-to-end`. Vally writes trajectories and reports under
`vally-results/`, which is excluded from version control. The fixtures contain
no Azure credentials, and the scenarios explicitly prohibit deployments, role
grants, and other cloud side effects.

For a quick local fallback, an existing Copilot CLI login can be reused with
`EVALUATE_USE_HOST_COPILOT_HOME=1`. Host-home mode also loads personal Copilot
settings and skills, so its routing results are not hermetic and should not be
used as the release gate.

## Commands

```bash
npm install
npm run build
npm run iac-compose -- ./deployment.ts --environment dev
npm run iac-compose -- ./deployment.ts --environment dev --dry-run
```

## Validate deployment access

`iac-compose validate` checks that every Azure resource provider used by the
generator is registered and that the deployment principal has the minimum
roles needed for generated data operations at the target scope:

```bash
iac-compose validate \
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
iac-compose validate \
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

`iac-compose generate` turns a solution plan and its resource requirements into a
chatbot-style TypeScript deployment program:

```bash
iac-compose generate \
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
`deployment/.iac-compose-codegen.json`, preserving files created separately in
the output directory. Generated code can live outside this package's dependency
tree: `iac-compose` resolves its generated `iac-compose` imports to the running
CLI package. Directly importing or compiling generated source still requires an
`iac-compose` dependency in the customer package.

Programmatic callers can observe generation phase boundaries without parsing
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
order. The CLI renders the same events as `[iac-compose] GENERATE` lines. The
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
iac-compose ./package/deployment/deploy.ts --environment dev --dry-run
iac-compose ./package/deployment/deploy.ts --environment dev
iac-compose ./package/deployment/deploy.ts --environment dev --component frontend
```

`--dry-run` renders provisioning entrypoints and writes their generated Bicep,
parameter files, and one `.generated/azure.yaml`. It does not initialize azd
environments, run cloud commands, or execute application deployment callbacks.
Each provisioning component is a named Bicep layer whose files remain under
`.generated/<component>/`. `iac-compose` preserves authored lifecycle ordering by
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
iac-compose down ./package/deployment/.generated --environment dev --force
```

Cleanup requires an explicit environment, `--force`, and iac-compose ownership
metadata in `azure.yaml`; it refuses arbitrary azd project directories. Add
`--purge` to permanently remove resources that Azure otherwise soft-deletes.

`-C <directory>` changes the deployment working directory. A program can use
`deployment.inDirectory(...)` for a scoped child context.

`--component <name>` passes a deployment-defined component selector to the
program. Programs that support component selection can use it to run one
component while keeping their default full deployment unchanged.

## Provisioning libraries

A provisioning entrypoint can export a non-empty `outputBicep` array of
`{ path, contents }` objects. Workspace libraries that require their own loader
can instead provide a compiler command and its artifact directory:

```ts
await deployment.provision("resources", {
  compiler: { command: "pnpm", args: ["run", "compile"] },
  artifactsDirectory: "generated/bicep",
  outputDirectory: ".generated/resources",
  location: process.env.AZURE_LOCATION,
});
```

The runtime records all layered artifact paths in the single
`.generated/.iac-compose-generated.json` manifest and only replaces files under
the layer being regenerated. Existing per-layer manifests are migrated into
that root manifest. Standalone provisioning keeps its manifest in its output
directory. Layered provisioning merges a JSON-compatible
`.generated/azure.yaml`, synchronizes its shared azd environment, runs
`azd provision <layer>`, and returns azd environment outputs as strings. For an
`outputDirectory` directly under `.generated`, the runtime infers the layer name
from the directory name and `dependsOn` from the order in which provisioning
calls first appear. Other output directories retain a standalone azd project.

## Chatbot integration

The chatbot is its own npm package. Its provisioning dependencies are pinned to
package-specific GitHub release assets from
`Azure/js-provisioning-lib` in `examples/chatbot/package.json`; chatbot source
never imports a neighboring provisioning workspace or its `dist` directories.
Install them with:

```bash
npm ci --prefix examples/chatbot
```

Generated deployment packages use those same release assets bundled under this
package's `vendor/` directory, so deployment workers do not require GitHub
credentials when installing generated dependencies.

The chatbot consumes this tool through the relative
`iac-compose: file:../..` package dependency and imports only the package
export, never the root `src` directory.

[examples/chatbot/src/deploy.ts](examples/chatbot/src/deploy.ts) is the centralized
business-order program:

```ts
await shared(deployment);
await agent(deployment);
await agentServer(deployment);
await functionApp(deployment);
await frontend(deployment);
await logicApp(deployment);
await knowledgeSync(deployment);
```

All implementation is grouped under
[examples/chatbot/src](examples/chatbot/src):

- `components/shared/` owns only the resource group, shared storage, identity,
  registry, configuration, Search, Cosmos DB, Key Vault, and Graph application.
- `components/agent/`, `components/frontend/`, `components/agent-server/`, and
  `components/function-app/` each own a colocated provisioning stack and run it
  immediately before that component's configuration and deployment.
- `components/agent/` owns the bot managed identity and deploys the hosted
  Foundry agent through a generated `azure.ai.agent` service, reading status
  through `azd ai agent show`.
- Application containers are built, published, and deployed by source-backed
  `azd deploy <service>` targets; component code supplies its source, Docker
  configuration, target resource, and settings.
- `components/logic-app/` waits for the Function host and then provisions its integration
  account, connections, complete workflow, identities, and alert from the typed
  TypeScript stack colocated in `provisioning.ts`. There is no workflow JSON or
  management API patch. Its Teams tenant, group, and channel IDs are selected
  from the component-local `config/<environment>.json` profile. Refresh the
  `dev`, `preview`, and `prod` profiles from the sibling `sdk-ai-bots`
  environment suite with:

  ```bash
  npm --prefix examples/chatbot run sync:logic-app-config
  ```
- `components/knowledge-sync/` owns Search bootstrap through the official Azure
  SDK and runs the application-owned synchronization process.
- `runtime/` contains only chatbot-specific environment composition and paths.
  Azure CLI execution, retries, readiness checks, azd App Service and Function
  deployment, RBAC, resource-group creation, account lookup, and environment-file
  primitives are exported by `iac-compose` itself.

Deployment outputs and lifecycle values are stored in the shared azd environment
under `examples/chatbot/.generated/.azure/`. Non-secret environment inputs live
in `examples/chatbot/src/environments/<environment>.json`.

Prerequisites for a real deployment are Node.js 20.6+, `azd` 1.30.0+, `az`, `pnpm`,
`npm`, authenticated azd and Azure CLI sessions, and Microsoft 365 access for
Teams app registration. The deploying identity also needs Microsoft Graph application and
app-role-assignment permissions for the Graph Bicep resources. Tenants that
enforce Service Tree ownership for app registrations require a service management
reference. The generate command embeds the fixed chatbot Service Tree ID in its
Graph application definitions; manually authored deployments must supply their
own reference.

Knowledge synchronization additionally requires:

- `AZURE_SDK_DOCS_PATH` and `AZURE_SDK_WIKI_PATH` pointing to the two internal
  repository checkouts;
- `AZURE_SDK_GITHUB_PAT` in the shell for token-authenticated GitHub sources;
- a base64-encoded `SSH-PRIVATE-KEY` secret in the provisioned Key Vault.

On a new environment, the first run provisions the Teams API connection and
then stops with its Azure portal consent URL. The same component provisioning
program runs with the workflow condition disabled for this bootstrap. Authorize
the connection and rerun; the next component provision includes the complete
workflow, and completed lifecycle functions are idempotent.

```bash
npm run iac-compose -- examples/chatbot/src/deploy.ts -e dev --dry-run
npm run iac-compose -- examples/chatbot/src/deploy.ts -e dev
npm run iac-compose -- examples/chatbot/src/deploy.ts -e dev --component logic-app
npm run iac-compose -- down examples/chatbot/.generated -e dev --force
```

The chatbot component names are `shared`, `agent`, `agent-server`,
`function-app`, `frontend`, and `logic-app`.