# Workspace opt-in: TypeScript Azure infrastructure with iac-composer

The discovery target is the **implementation method**, not an architecture
planner. In an opted-in workspace, requests such as:

> Implement these Azure resources with managed identity access.

should lead to customer-owned TypeScript using `@azure/provisioning-*`, resource
references, and `iac-composer` composition and provisioning/deployment helpers.
Bicep is generated output. Requirements can come from the user or **any**
planning workflow; no particular planner, logical resource-kind vocabulary,
generator package, or JSON contract is required.

Honor explicit implementation tools and existing compatible IaC. For unresolved
architecture decisions, use an appropriate planning workflow and then resume
implementation. Do not reselect services simply to use this runtime.

## 1. Install or build iac-composer only

Use Node.js 20.6 or newer and a reviewed, pinned runtime package or checkout.
From a checkout:

```bash
npm ci
npm run build
```

The standalone local MCP binary is `iac-composer-mcp`, implemented in
`dist/mcp/cli.js` in the same package as the runtime. Building
`tools/azure-infrastructure`, installing its skill, and preparing its contracts
are **not** prerequisites.

The consumer project declares the provisioning libraries it actually imports:
`@azure/provisioning-core`, `@azure/provisioning-serialization`,
`@azure/provisioning-bicep`, and resource-specific packages such as
`@azure/provisioning-storage`. Inspect existing manifests/versions first; do
not silently install an unrelated latest tool or a management SDK.

## 2. Install the implementation skill

From the consumer repository, with GitHub CLI 2.97 or newer:

```bash
gh skill install qiaozha/iac-composer iac-composer \
  --agent codex --scope project --pin <REVIEWED_REF> --allow-hidden-dirs
```

This creates `.agents/skills/iac-composer`, a common project location supported
by Copilot and Codex. It does not require the Codex application. Other hosts
can use MCP or the instruction/file bridge below. Do not install duplicate full
skill trees in several auto-scanned locations.

For unpublished changes use the reviewed checkout path instead of the GitHub
repository, add `--from-local`, and omit `--pin`; pin the checkout itself.
GitHub CLI 2.97's local installer accepted the canonical name but rejected
path-shaped selectors in verification. Do not use `--force` without review.

## 3. Add the conditional workspace policy

Merge the [AGENTS routing block](AGENTS.md.template) into the consumer-root
`AGENTS.md`. Do not replace an existing instruction file. It prefers TypeScript
SDK resource definitions and iac-composer when no implementation method or
existing convention applies, not when the user explicitly chose Terraform,
Bicep, azd, REST/management SDKs or another approach.

If a host/version does not load `AGENTS.md`, merge the
[minimal Claude bridge](CLAUDE.md.template) into the already-active
`CLAUDE.md` where appropriate. Preserve unrelated project instructions. Use
one workflow route rather than loading the same body through both skill and
MCP. Architecture-only, inventory and unrelated diagnostic requests are not
redirected into implementation.

## 4. Register the root-owned, read-only MCP tools

| Host | Workspace registration | Profile |
| --- | --- | --- |
| Copilot CLI, Claude Code | `.mcp.json` with `mcpServers` | [Portable](profiles/portable-mcp.json) |
| Copilot in VS Code | Root portable configuration when supported by the selected harness/settings | [Portable](profiles/portable-mcp.json) |
| VS Code compatibility setup | `.vscode/mcp.json` with `servers`, only if portable registration is inactive | [VS Code](profiles/vscode-mcp.json) |
| Codex | Trusted project `.codex/config.toml` | [Codex](profiles/codex-config.toml) |
| Other local MCP hosts | Their own project configuration | [Stdio launch contract](profiles/stdio-server.json) |

Merge only the `iac-composer` server entry; preserve other servers and approval
settings. For portable configuration, supply these non-secret paths to the
process launching the host:

```bash
export IAC_COMPOSER_ROOT="/absolute/path/to/reviewed/iac-composer-package"
export IAC_COMPOSER_WORKSPACE_ROOT="$PWD"
```

Portable configurations use `${NAME}`; VS Code compatibility uses
`${env:NAME}` and `${workspaceFolder}`. Codex arguments are not shell
expressions: replace `/REPLACE/...` with reviewed absolute paths. Do not assume
one variable-substitution syntax works in every host. An integrated terminal's
environment does not necessarily configure the VS Code extension host.

Copilot CLI does **not** read `.vscode/mcp.json`. Use its portable project file
and normal trust flow; do not bypass untrusted-project restrictions. VS Code
root portable support depends on version/harness/settings; where necessary
review `chat.mcp.workspaceRootConfig.enabled`. Claude requires project MCP
approval; Codex requires a trusted project. Do not activate duplicate portable
and compatibility connections, or change global agent profiles automatically.

## MCP capabilities

### `iac_composer_get_context`

Read-only implementation discovery; `topic` defaults to `start`.

- `start`: TypeScript resource authoring, planner-neutral requirements,
  composition, validation, provision/deploy workflow and effects.
- `authoring`: canonical SDK Stack/resource/outputBicep and deployment examples.
- `sdk`: provisioning libraries declared by the Node project and installed
  version/availability. Optional `projectDirectory` selects a project inside
  the workspace, such as `deployment`.
- `helpers`: composition, environment, azd, identity/access, readiness and
  application lifecycle APIs with targeted declaration lookup.
- `provisioning`, `commands`, `report`: the runtime's existing structured
  capabilities, including preview and execution behavior.

No Azure service catalog or planner-specific schema is required or loaded.

### `iac_composer_get_reference`

Read actual TypeScript declarations without importing/executing SDK code:

```json
{
  "packageName": "@azure/provisioning-storage",
  "symbol": "StorageAccount",
  "projectDirectory": "deployment"
}
```

`packageName` defaults to `iac-composer`, for helpers such as
`ensureRoleAssignment`, `ProvisionOptions` or `Deployment`. Only the runtime
and `@azure/provisioning-*` packages are accepted. Omit `symbol` for a bounded
entrypoint excerpt; optional `file` narrows lookup to a package-relative
declaration file. With `file` and no `symbol`, optional `line` selects the
1-based start of a bounded excerpt for paging through longer definitions.

Lookup reports the actual installed version, declaration filenames, line
numbers, excerpts and truncation. It never downloads packages, executes
package entrypoints, or substitutes REST/management SDK request shapes.
Missing packages/symbols and invalid paths fail explicitly. Reads are limited
to declaration files inside the resolved package; symlinks cannot escape it.
Scan limits are 256 files, 2 MiB per file and 8 MiB total; at most three bounded
excerpts and twenty file names are returned. Narrow lookup when truncated.
These are installed SDK types, not a complete ARM/provider validation schema.

Both tools return versioned structured content and diagnostics, with
`isError: true` and `status: "failed"` on handled errors. Stdout is protocol-only.
There is no code generation contract, automatic SDK installation, telemetry
upload, or cloud-execution operation in this MCP server.

## Author, validate and execute through the runtime

The agent writes TypeScript provisioning source, exports rendered `outputBicep`,
and composes it with `defineDeployment`, `deployment.provision`, returned
outputs, and explicit lifecycle helpers. Resource relationships belong in SDK
references; persistent resources should not be replaced by ad hoc CLI scripts.

After project typechecking and appropriate Bicep checks, use the existing CLI:

```bash
iac-composer ./deployment.ts --dry-run --report preview.json
```

Only when the user authorizes infrastructure execution:

```bash
iac-composer ./deployment.ts --environment dev --report deployment.json
```

Provisioning/deployment uses the runtime's existing azd integration. A dry run
executes trusted modules/compilers and writes local artifacts; it is not a
sandbox, Azure what-if, permission check or deployment guarantee. Keep secrets
out of source, logs and arguments. Deployment, role grants, authentication and
deletion are not authorized by installing a skill or registering MCP.

## Optional planning/generation integrations

Any planning skill/tool can provide resource requirements. The separate
`azure-infrastructure` planner/contract generator is one optional upstream
integration; do not install it or convert requirements to its JSON inputs merely
to implement resources with iac-composer.

If an earlier experimental setup routed all creation requests through that
planner, replace its routing block and primary MCP registration with these
runtime-owned profiles. Keep its separate server only if that specific
planner/generator is wanted. Do not delete existing consumer files blindly.

## Verify the intended selection

Use the [evaluation cases and recording protocol](evaluation/README.md).
The key trial installs only iac-composer, supplies an Azure resource plan from
another source, and checks for TypeScript SDK resource definitions, helper use
and runtime provisioning/preview without a required recognition skill or JSON
contract.

Native skill installation, packed-runtime isolation and MCP protocol tests
verify availability and behavior, not model choice. Fresh real-host trials
are still required to claim unprompted selection improvements; unavailable
hosts or telemetry must be recorded as unverified, not successful.
