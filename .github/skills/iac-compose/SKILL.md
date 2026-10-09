---
name: iac-compose
description: Author, generate, validate, and run Azure infrastructure as code with iac-compose after the resource plan is known. Use directly when the user names the Azure resources or supplies a complete plan, and for TypeScript or JavaScript deployment programs, provisioning layers, contract generation, output wiring, or iac-compose troubleshooting. Do not invoke architecture intent recognition for a complete plan; pair with azure-infrastructure-intent only for sparse outcome-based requests.
license: MIT
compatibility: Requires Node.js 20.6 or newer. Azure execution requires Azure Developer CLI (azd) 1.30 or newer, Azure CLI, and authenticated Azure access.
metadata:
  author: qiaozha
  version: "1.4"
---

# Define infrastructure with iac-compose

Turn the requested Azure architecture into repeatable, checked-in source while
keeping infrastructure provisioning and application deployment in explicit
business order.

When the user describes a workload outcome but does not identify the Azure
resources, first apply the `azure-infrastructure-intent` skill. Carry its
workload profile, assumptions, service choices, and Well-Architected controls
into this authoring workflow.

When infrastructure intent recognition provides
`implementation-contract.json`, read
[the implementation contract handoff](references/implementation-contract-handoff.md).
Treat the contract as the complete customer-specific resource plan. Do not
repeat reference discovery or expose any internal architecture match.

Do not apply this skill to advice-only or architecture-plan-only requests. It
starts when resource implementation, generation, validation, or execution is
requested.

## Guardrails

- Work in the user's target repository and follow its package-manager, module,
  formatting, naming, and environment conventions.
- Reuse existing deployment programs, provisioning layers, environment helpers,
  and component boundaries before adding new ones.
- Keep credentials and secrets out of source, generated manifests, parameters,
  logs, and command arguments. Read them from the environment or an approved
  secret store.
- Treat generated Bicep, `azure.yaml`, `.azure/`, and
  `.iac-compose-generated.json` as artifacts. Change their authored inputs
  rather than patching generated files.
- Preserve lifecycle order. Do not parallelize steps whose inputs or side
  effects depend on earlier steps.
- Fail explicitly for missing required configuration, unknown components,
  unsupported resource kinds, unresolved output bindings, or missing outputs.
- Keep internal architecture-catalog titles, IDs, URLs, source commits, sample
  links, and candidate scores out of generated source. If the user explicitly
  requested provenance, report it separately from infrastructure artifacts.
- A dry run may compile provisioning source and update generated local
  artifacts, but it must not perform Azure or application side effects.
- Do not run a real deployment, `validate --grant`, or `down` unless the user
  explicitly asks for that side effect. `down --purge` requires separate,
  explicit confirmation because it permanently removes soft-deleted resources.

## Choose the authoring workflow

Use one workflow consistently unless the repository already combines them:

1. **Contract-driven generation** is preferred when the requested resources fit
   the supported resource kinds and the user wants a generated component
   deployment package. Read
   [the contract workflow reference](references/contract-workflow.md).
2. **Direct TypeScript composition** is preferred for custom resources,
   existing provisioning-library code, custom compilers, or repositories that
   already own their deployment lifecycle. Read
   [the direct authoring reference](references/direct-authoring.md).

Do not force an unsupported Azure resource into a vaguely similar contract
kind. Use direct authoring for that resource instead. If contract-generated
defaults cannot satisfy the selected security, networking, reliability,
scaling, backup, or observability profile, use direct authoring rather than
weakening the architecture.

## Required process

### 1. Inspect before editing

Identify:

- the package manager, Node.js version, module format, and existing scripts;
- existing `iac-compose`, `azure.yaml`, `.generated`, deployment, environment,
  and provisioning files;
- application components, their source directories, and Dockerfiles;
- the intended Azure subscription, tenant, scope, environment names, and
  locations when they are already configured;
- existing output names and consumers;
- an existing `implementation-contract.json` and its final authoring mode,
  resource ownership, outputs, dependency edges, blockers, and validation
  requirements.

Do not replace a working project structure with a generic template.

### 2. Model ownership and order

Split the solution into components with clear owners:

- put resources used by several components in a shared layer;
- colocate component-only resources with that component;
- provision each component immediately before its application lifecycle;
- express cross-component dependencies through outputs and consume them only
  after their producer;
- keep environment preparation first and interactive or post-provisioning
  actions after their prerequisites.

For a multi-component direct deployment, expose a component map and honor
`deployment.component`. Reject unknown component names with the valid names in
the error. Use `Object.hasOwn` for object-backed maps, or use a `Map`, so
inherited keys such as `toString` cannot be selected as components.

### 3. Author the smallest complete solution

For contract generation:

- translate only resources whose implementation mode is `contract`;
- create schema version `1.0` resource requirements and solution files;
- declare every enabled component in both inputs;
- give every resource a unique `id`, supported `kind`, and non-empty
  `requiredBy`;
- declare unique `produces` values and reference them with
  `${output.<name>}`;
- include each resource in `solution.resources.planned` when that section is
  present;
- generate the deployment package, then inspect the component order and owned
  files.

For direct composition:

- implement the provider-qualified Azure resource types and controls declared
  by direct resources in the implementation contract;
- default-export `defineDeployment(async (deployment) => { ... })`;
- make each provisioning entrypoint export a non-empty `outputBicep` array of
  `{ path, contents }`;
- call `deployment.provision` with an entrypoint or with a compiler plus
  `artifactsDirectory`;
- use one `.generated/<component>` output directory per layer;
- use returned outputs rather than reconstructing resource names or endpoints;
- wrap application and configuration side effects in `deployment.deploy`,
  commands in `deployment.run`, and ordered environment changes in
  `deployment.env`.

### 4. Handle configuration deliberately

- Use `requiredEnv` for mandatory values and explicit defaults only where the
  architecture permits them.
- Prefer `AZURE_LOCATION` for the solution location and
  `AZURE_AI_LOCATION` for AI resources when those regions differ.
- Pass Bicep parameter values through `parameters` or `environmentValues`;
  never interpolate secrets into generated source.
- Persist outputs in the repository's existing azd environment when later
  components or reruns need them.
- Keep production restrictions and CI-only policies already present in the
  repository.

### 5. Validate in increasing order of cost

Use the repository's existing commands and local dependency:

1. Format or lint only the changed files when configured.
2. Run the narrowest relevant typecheck or tests.
3. For generated packages, install their declared dependencies only if needed,
   then run their typecheck.
4. Run the deployment with `--dry-run`. Confirm source compilation, generated
   layer order, step order, component selection, and absence of side effects.
5. When authenticated Azure access is available and the user requested it, run
   `iac-compose validate` without `--grant` first.
6. Perform a real deployment only when explicitly requested.

Use the local package script or package-manager executable. Do not silently
download and execute a different `iac-compose` version.

## Completion checklist

Before reporting completion, verify that:

- authored files, not generated artifacts, contain the intended change;
- every referenced component, resource, output, path, and environment variable
  exists;
- resource ownership and deployment order match the requested architecture;
- generated TypeScript and provisioning entrypoints typecheck;
- the dry run completes and lists the expected ordered steps;
- no secret or local azd state was added to version control;
- no internal architecture reference metadata leaked into generated files or
  the completion report;
- any operation not executed because it would change Azure is called out
  clearly with the exact next command.
