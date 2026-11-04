# Optional planner and contract-generator MCP integration

This server belongs to the optional `azure-infrastructure` architecture and
contract-generation tool. It is **not** the discovery entry point required to
author or provision resources with iac-composer.

For implementation from the user or any planning workflow, use
[iac-composer's own skill and MCP setup](../../../agent-setup/README.md).
Those tools expose TypeScript provisioning-library authoring, actual installed
SDK/helper declarations and runtime validation/provision/deploy capabilities
without requiring this package or its JSON contracts.

If this planner/generator is specifically wanted, build the runtime and this
package, then register an additional reviewed local stdio server:

```json
{
  "command": "node",
  "args": [
    "/REPLACE/CHECKOUT/tools/azure-infrastructure/dist/mcp/cli.js",
    "--workspace",
    "/REPLACE/CONSUMER_REPOSITORY"
  ]
}
```

Use the host's project configuration and a distinct `azure-infrastructure`
server ID. Merge rather than overwrite existing configuration; do not make
this server a prerequisite of the `iac-composer` registration.

The optional tools remain:

- `azure_infrastructure_get_context`: architecture/contract workflow context,
  pinned catalog lookup, schemas and integration references. It does not infer
  an architecture inside the handler.
- `azure_infrastructure_generate`: deterministic local source generation from
  explicitly chosen `resourcesFile`, `solutionFile` and `outputDirectory`.

Generation replaces generator-owned source only and refuses workspace-root
output, input/output overlap, path/symlink escapes and unowned collisions. It
does not execute deployment source, authenticate, grant roles, deploy, delete
Azure resources or validate live permissions. Errors report a stage and safe
diagnostic; local generation is not proof of deployability.

The separate generator's logical kinds and component requirements constrain
that generator, **not** iac-composer's direct SDK authoring. In particular,
infrastructure-only plans do not need an application host merely to satisfy
this generator: implement them directly with the runtime.
