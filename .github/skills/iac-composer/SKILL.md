---
name: iac-composer
description: Author and run ordered TypeScript or JavaScript infrastructure as code with iac-composer. Use for deployment programs, provisioning layers, output wiring, dry runs, component selection, cleanup, and runtime troubleshooting. Cloud intent recognition, architecture planning, and contract-to-code generation belong to the separate azure-infrastructure tool.
license: MIT
compatibility: Requires Node.js 20.6 or newer. Azure execution requires Azure Developer CLI (azd) 1.30 or newer, Azure CLI, and authenticated Azure access.
metadata:
  author: qiaozha
  version: "2.0"
---

# Define infrastructure with iac-composer

Turn the requested Azure architecture into repeatable, checked-in source while
keeping infrastructure provisioning and application deployment in explicit
business order.

This skill consumes an already selected resource plan or authored provisioning
source. Cloud intent recognition, architecture planning, and contract-to-code
generation are owned by the separate `azure-infrastructure` tool, not this
runtime. Do not infer services or generate resource contracts in this workflow.

Do not apply this skill to advice-only or architecture-plan-only requests. It
starts when direct IaC authoring, local validation, or execution is
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
  `.iac-composer-generated.json` as artifacts. Change their authored inputs
  rather than patching generated files.
- Preserve lifecycle order. Do not parallelize steps whose inputs or side
  effects depend on earlier steps.
- Fail explicitly for missing required configuration, unknown components,
  unresolved output bindings, or missing outputs.
- A dry run may compile provisioning source and update generated local
  artifacts, but it must not perform Azure or application side effects.
- Do not run a real deployment, role grants, or `down` unless the user
  explicitly asks for that side effect. `down --purge` requires separate,
  explicit confirmation because it permanently removes soft-deleted resources.

## Direct composition

Read [the direct authoring reference](references/direct-authoring.md).
Reuse existing provisioning-library code, custom compilers, and lifecycle
helpers. Preserve the selected resource plan without redesigning it.

## Required process

### 1. Inspect before editing

Identify:

- the package manager, Node.js version, module format, and existing scripts;
- existing `iac-composer`, `azure.yaml`, `.generated`, deployment, environment,
  and provisioning files;
- application components, their source directories, and Dockerfiles;
- the intended Azure subscription, tenant, scope, environment names, and
  locations when they are already configured;
- existing output names and consumers;
- resource ownership, dependency edges, required controls, and validation
  requirements from the supplied plan.

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

- implement the provider-qualified Azure resource types and controls in the
  supplied plan;
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
3. Run the deployment with `--dry-run`. Confirm source compilation, generated
   layer order, step order, component selection, and absence of side effects.
4. Perform a real deployment only when explicitly requested.

Use the local package script or package-manager executable. Do not silently
download and execute a different `iac-composer` version.

## Completion checklist

Before reporting completion, verify that:

- authored files, not generated artifacts, contain the intended change;
- every referenced component, resource, output, path, and environment variable
  exists;
- resource ownership and deployment order match the requested architecture;
- generated TypeScript and provisioning entrypoints typecheck;
- the dry run completes and lists the expected ordered steps;
- no secret or local azd state was added to version control;
- any operation not executed because it would change Azure is called out
  clearly with the exact next command.
