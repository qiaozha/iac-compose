---
name: azure-infrastructure-intent
description: Infer Azure resource needs from a sparse business request or an existing application, select a cost-conscious Azure architecture using Well-Architected Framework guidance, and generate the infrastructure with iac-compose. Use for outcome-based Azure requests in an iac-compose workflow when the user has not named the resources, topology, security controls, or operational dependencies. Do not use when the resource plan is already complete; invoke iac-compose directly.
license: MIT
compatibility: Designed to pair with the iac-compose project skill. Local generation requires Node.js 20.6 or newer; Azure validation and deployment require azd, Azure CLI, and authenticated Azure access.
metadata:
  author: qiaozha
  version: "1.1"
---

# Infer Azure intent and generate infrastructure

Translate the user's desired outcome and repository evidence into the smallest
complete Azure architecture that is secure, operable, scalable, and
cost-conscious. Do not require the user to know Azure product names.

Unless the user explicitly asks only for advice or a plan, continue through
infrastructure generation and local validation. Apply the `iac-compose` skill
for the authoring and execution details.

For an explicit advice-only or plan-only request, complete service selection
and the Well-Architected review within this skill and stop. Do not invoke
`iac-compose` merely to inspect its authoring options; hand off only when the
user requests infrastructure implementation.

## Non-negotiable behavior

- Inspect the application before asking infrastructure questions.
- If the user already supplied a complete resource plan, do not repeat intent
  recognition or reconsider the architecture. Apply the `iac-compose` skill
  directly.
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
- Do not omit a required control because the contract generator cannot express
  it. Use direct TypeScript authoring when necessary.
- Do not invent `iac-compose` resource kinds or output names.
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
- existing Azure, Bicep, Terraform, azd, and `iac-compose` files;
- tests, documentation, and deployment workflows that reveal scale,
  availability, or environment expectations.

Treat explicit user requirements as highest priority, followed by repository
evidence, existing infrastructure choices, framework conventions, and finally
documented defaults. Never infer architecture from a product name alone.

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

### 7. Convert the architecture to iac-compose

Build a resource graph with:

- component ownership;
- shared resources;
- dependencies and deployment order;
- outputs and runtime consumers;
- environment parameters;
- identity and RBAC edges;
- lifecycle actions that occur after provisioning.

Then apply the `iac-compose` skill:

- use contract-driven generation only when every required resource and
  Well-Architected property is supported by the contract;
- use direct TypeScript authoring when a service, SKU, network control,
  diagnostic setting, backup policy, scaling rule, or reliability requirement
  is not expressible by the contract;
- use a deliberate hybrid only when the repository already has that pattern
  and ownership remains unambiguous;
- change authored inputs, not generated Bicep or azd artifacts;
- provision producers before consumers and wire values through declared
  outputs rather than reconstructed names.

Do not stop after producing a service list. Create the resource contracts or
TypeScript provisioning layers, deployment program, environment parameters,
and required package updates.

### 8. Verify the emitted infrastructure

Use the repository's existing format, typecheck, and test commands, then:

1. Run the narrowest relevant `iac-compose` generation validation.
2. Typecheck generated or directly authored deployment source.
3. Run `iac-compose` with `--dry-run`.
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
