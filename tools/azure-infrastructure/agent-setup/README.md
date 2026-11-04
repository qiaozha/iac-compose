# Setup ownership has moved to iac-composer

The planner-neutral implementation setup is now owned by the runtime:
[iac-composer workspace setup](../../../agent-setup/README.md).

Install that skill/server to implement Azure resources as TypeScript using
provisioning libraries and runtime helpers. This optional planner and its
contract format are not prerequisites.

For users who deliberately choose the separate architecture/contract generator,
see its [optional MCP integration](../docs/mcp.md). Do not use the former
planner-first routing policy as the default implementation policy.
