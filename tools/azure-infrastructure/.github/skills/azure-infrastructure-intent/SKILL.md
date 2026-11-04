---
name: azure-infrastructure-intent
description: Recognize Azure workload intent and select a cost-conscious architecture when planning is needed, or generate TypeScript when the separate azure-infrastructure contract generator is explicitly chosen. This is an optional planning/generation workflow, not a prerequisite for implementing Azure resources with iac-composer. Skip service selection for a complete plan. Honor explicit tools and existing IaC conventions. Not for ordinary direct TypeScript resource authoring, inventory, cost-only questions, or unrelated production diagnostics.
license: MIT
compatibility: Requires the azure-infrastructure package and Node.js 20.6 or newer for local generation. Generated deployments use iac-composer; Azure validation and deployment require azd, Azure CLI, and authenticated Azure access.
metadata:
  author: qiaozha
  version: "2.2"
---

# Infer Azure intent and generate infrastructure

## Workspace routing

Use this optional workflow for architecture recognition or when its
contract-to-code generator is chosen. It is not the mandatory front door for
resource implementation: the `iac-composer` skill can implement requirements
from any planner or the user directly with TypeScript provisioning libraries.
Honor explicit tool choices, existing IaC conventions and higher-priority
instructions. Do not replace Terraform, Bicep, or azd implicitly.

An existing complete plan skips service selection. Direct resource authoring
and existing deployment programs go to `iac-composer`, without converting the
plan into this generator's input format unless generation is requested. This
optional tool's MCP entry point is `azure_infrastructure_get_context`; the
independent implementation entry point is `iac_composer_get_context`.

## Desired outcome

Translate the user's desired outcome and repository evidence into the smallest
complete Azure architecture that is secure, operable, scalable, and
cost-conscious. Do not require the user to know Azure product names.

The customer-visible boundary is `implementation-contract.json`. Internal
reference matching can improve completeness, but must never appear in that
contract. If provenance is explicitly requested, provide it separately.

Unless the user asks only for advice or a plan, hand the selected resource
requirements to the `iac-composer` implementation skill for TypeScript
provisioning-library authoring and local validation. Use this package's
contract-to-code generator only when that workflow is chosen; read
[the contract workflow](references/contract-workflow.md) and
[the implementation handoff](references/implementation-contract-handoff.md)
for that optional route.

For an explicit advice-only or plan-only request, complete service selection
and the Well-Architected review within this skill and stop. Do not invoke
`iac-composer` merely to inspect its authoring options; hand off only when the
user requests infrastructure implementation.

## Non-negotiable behavior

- Inspect the application before asking infrastructure questions.
- If the user already supplied a complete resource plan, do not repeat intent
  recognition or reconsider the architecture. Preserve the plan and hand it
  to implementation; use this generator's contracts only if generation is
  chosen.
- Infer routine choices and state assumptions instead of making the user design
  Azure resources.
- Ask only when an unresolved choice would materially change data semantics,
  security or compliance, public exposure, recovery guarantees, migration
  safety, or cost.
- Prefer managed platform services over virtual machines and self-managed
  clusters unless the workload requires infrastructure control.
- Apply all five Azure Well-Architected Framework pillars. Security and
  reliability do not override cost or simplicity without a workload reason.
- Do not add a service merely because it is common. Every resource must satisfy
  an observed or inferred capability.
- Treat Azure Architecture Center matching as private decision support. Never
  put the catalog, a matched example, its title, ID, URL, source commit, or
  implementation repository in the implementation contract or generated
  infrastructure. Mention provenance separately only when explicitly asked.
- Do not omit a required control because the contract generator cannot express
  it. Use direct TypeScript authoring when necessary.
- Do not invent `iac-composer` resource kinds or output names.
- Keep regions, environment names, globally unique names, and adjustable
  capacity parameterized.
- Never place credentials or secrets in source, parameters, generated
  manifests, logs, or command arguments.
- Generate source and run a dry run by default. Do not deploy, grant roles, or
  delete resources unless the user explicitly requests that side effect.

## Workflow

### 1. Extract workload evidence

Read [the intent model](references/intent-model.md) and inspect:

- application manifests, dependencies, source imports, framework
  configuration, routes, and startup commands;
- Dockerfiles, ports, health endpoints, schedulers, workers, and background
  processes;
- database drivers, migration files, local file writes, queues, event
  consumers, caches, search, and AI SDK usage;
- environment variable names and configuration schemas, without exposing
  values;
- authentication and authorization code, tenant assumptions, certificates,
  and external credentials;
- existing Azure, Bicep, Terraform, azd, and `iac-composer` files;
- tests, documentation, and deployment workflows that reveal scale,
  availability, or environment expectations.

Treat explicit user requirements as highest priority, followed by repository
evidence, existing infrastructure choices, framework conventions, and finally
documented defaults. Never infer architecture from a product name alone.

After building the workload evidence, read
[the Architecture Center workflow](references/architecture-center-workflow.md)
and use
[the pinned architecture catalog](references/architecture-catalog.json).
Use the catalog to check whether the workload aligns with a proven topology,
but keep the lookup and match internal. The catalog is discovery metadata, not
a deployable topology. Read the best candidate's full pinned content before
selecting or generating resources.

### 2. Build the intent model

Identify:

- workload purpose and user-facing journeys;
- deployable components and their protocols;
- synchronous, asynchronous, scheduled, and batch execution;
- durable, relational, document, object, cache, search, and analytics data;
- identity boundaries, external exposure, secrets, and sensitive data;
- expected environment, criticality, scale shape, and operational needs;
- existing services that must be preserved;
- assumptions and the evidence or default behind each one.

Classify each conclusion as `explicit`, `evidenced`, `defaulted`, or
`unresolved`. Do not block on a `defaulted` conclusion when it can be
parameterized and changed safely later.

### 3. Select a workload profile

Read [the Well-Architected baseline](references/well-architected-baseline.md)
and choose:

- **sandbox** for demos, experiments, personal projects, and development-only
  workloads;
- **standard** for ordinary business workloads and as the fallback when no
  stronger signal exists;
- **mission-critical or regulated** only when the user, repository, or policy
  evidence requires it.

The profile controls reliability, networking, observability, backup, scaling,
and SKU expectations. It must not change the application's data model or
protocol.

### 4. Apply the minimal-question gate

First try to resolve gaps from code, existing configuration, and parameters.
Ask one focused question at a time only if a gap is still critical.
Include one short sentence explaining which architecture, safety, compliance,
or cost decision the answer controls. Do not hide a second question in that
explanation.

Typical critical gaps are:

- an existing production database must be migrated but the engine or migration
  tolerance is unknown;
- regulated or sensitive data has no known residency or connectivity policy;
- repository evidence conflicts on whether an endpoint is public or private;
- a mission-critical claim lacks enough recovery or availability information
  to choose a safe topology;
- two plausible choices differ by an order of magnitude in expected cost;
- adopting the inferred service would require an irreversible application
  change.

Do not ask the user to choose routine resource names, starter SKUs, monitoring,
managed identity, tags, TLS settings, or an IaC layout. Choose and parameterize
those.

If the user cannot answer a critical question, generate a safe,
non-deploying configuration with an explicit required parameter, stop before
cloud execution, and explain what must be resolved before deployment.

### 5. Select Azure services

Read [the service selection reference](references/service-selection.md).

For each component:

1. Identify the capability, not a preferred product.
2. Preserve an existing compatible data engine and hosting constraint.
3. Choose the lowest-operational-overhead managed service that meets the
   capability and workload profile.
4. Add supporting identity, registry, configuration, observability, network,
   backup, and recovery resources required for that service.
5. Record why the service was selected and what evidence would cause the choice
   to change.

Evaluate compute per component. A solution can legitimately use different
compute services for a web API, event processor, scheduled job, and batch
worker. Do not select AKS only because the application has a Dockerfile.

Before finalizing a core service, consult its current Microsoft
Well-Architected service guide or official product guidance for required
security, reliability, networking, and operational properties. Treat the
reference matrices as starting points, not substitutes for current service
limits and regional capabilities.

### 6. Run the Well-Architected gate

Review the proposed architecture against every pillar:

- **Reliability:** failure modes, health probes, redundancy, backups, restore,
  recovery objectives, and dependency behavior.
- **Security:** managed identity, least-privilege RBAC, secret handling,
  encryption, local-auth disablement, and minimum public exposure.
- **Cost optimization:** justified resources, right-sized starting capacity,
  autoscaling, retention, environment-specific tiers, and avoidable fixed
  cost.
- **Operational excellence:** deterministic IaC, logs, metrics, traces,
  diagnostics, alerts, safe rollout, and actionable outputs.
- **Performance efficiency:** scaling unit, concurrency, quotas, partitioning,
  latency, and likely bottlenecks.

Resolve missing baseline controls before authoring. For intentional deviations,
record the affected pillar, rationale, tradeoff, and trigger for revisiting the
decision.

### 7. Hand off to infrastructure implementation

Build a resource graph with:

- component ownership;
- shared resources;
- dependencies and deployment order;
- outputs and runtime consumers;
- environment parameters;
- identity and RBAC edges;
- lifecycle actions that occur after provisioning.

When this planning workflow's implementation contract is requested, create
one that conforms to
[the implementation contract schema](references/implementation-contract.md).
The contract is the customer-visible handoff and contains only the inferred
workload design:

- solution profile and final authoring mode;
- components, source paths, protocols, and lifecycle;
- resources, ownership, required capabilities, configuration, and controls;
- supported contract kinds or direct Azure resource types;
- outputs, consumers, identities, access grants, and dependency edges;
- parameters, deployment order, assumptions, tradeoffs, unresolved blockers,
  and validation requirements.

Do not include internal catalog or source provenance in this contract. Explain
service choices from user requirements and repository evidence, never by
saying that the workload matches a reference example.

Validate the [implementation handoff](references/implementation-contract-handoff.md),
when using its contract workflow, then choose the authoring route:

- use contract-driven generation only when that workflow is chosen and every required resource and
  Well-Architected property is supported by the contract. Read
  [the contract workflow](references/contract-workflow.md) and run
  `azure-infrastructure generate`;
- otherwise hand the resource requirements directly to the `iac-composer`
  skill for TypeScript provisioning-library authoring and ordered execution,
  without requiring translation into generator inputs;
- use a deliberate hybrid only when the repository already has that pattern
  and ownership remains unambiguous;
- change authored inputs, not generated Bicep or azd artifacts;
- provision producers before consumers and wire values through declared
  outputs rather than reconstructed names.

Do not stop at a service list when implementation was requested: continue into
TypeScript provisioning layers, deployment program, environment parameters and
required package updates through the implementation skill. A complete selected
plan does not require `implementation-contract.json` or generator input files
to use iac-composer. If the user requested only a plan or contract, stop without
source generation or execution.

### 8. Verify the emitted infrastructure

Use the repository's existing format, typecheck, and test commands, then:

1. If this generator was used, run its narrowest relevant validation.
2. Typecheck generated or directly authored deployment source.
3. Run `iac-composer` with `--dry-run`.
4. Inspect the generated Bicep and `azure.yaml` for the actual selected SKUs,
   identities, RBAC, network exposure, TLS, backups, diagnostics, scaling, zone
   behavior, tags, outputs, and layer order.
5. Repeat the Well-Architected gate against emitted IaC, not merely the intended
   plan.
6. When Azure access is available and requested, validate providers, quotas,
   regional availability, and principal roles without granting first.

If generated defaults violate the selected profile, change the authored
approach and regenerate. Do not waive the issue just because generation
succeeded.

## Completion report

Report concisely:

- inferred workload intent and selected profile;
- Azure resources generated and why;
- important defaults, assumptions, and Well-Architected tradeoffs;
- files created or changed;
- validation performed;
- deployment-time decisions or commands still requiring user approval.

Do not name or cite an internally matched Architecture Center example in the
completion report unless the user explicitly requested provenance. Even then,
keep it separate from the implementation contract and generated infrastructure.
