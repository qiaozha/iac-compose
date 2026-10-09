# Implementation contract handoff

Consume `implementation-contract.json` as the final workload-specific resource
plan from infrastructure intent recognition. Do not repeat architecture
matching or infer a different topology unless the contract is invalid or a
repository conflict makes it unsafe.

## Privacy boundary

The contract and generated package must not contain internal reference
material: catalog IDs, titles, URLs, source commits, official sample links, or
candidate scores. Do not add this provenance to comments, status files, or the
completion response. If such fields appear unexpectedly, stop and remove them
before generation.

## Validate the handoff

Before authoring, verify:

- `schemaVersion` is `1.0`;
- component and resource IDs are unique;
- every `requiredBy` component exists;
- `deploymentOrder` names valid components or shared layers;
- every dependency has one producer and consumer;
- every consumed output has one producer;
- contract resources use a supported kind and output names;
- direct resources declare provider-qualified ARM resource types;
- the overall `authoringMode` agrees with per-resource routes;
- unresolved blocking decisions are empty.

Fail explicitly when these invariants do not hold. Do not silently choose a
service or fabricate an output to repair the contract.

## Select authoring

- For `contract`, translate components and contract resources into
  `config/resource-requirements.json` and `solution.json`, then run generation.
- For `direct`, author the complete graph in TypeScript provisioning layers.
- Use `hybrid` only when the repository already has an unambiguous ownership
  pattern. Never define one resource through both paths.

The `capability`, `configuration`, and `controls` fields are requirements, not
documentation. If the supported kind cannot express one, switch to direct
authoring rather than weakening it.

## Preserve graph semantics

- Place multi-component resources in shared layers.
- Provision output producers before consumers.
- Use returned outputs rather than reconstructing names or endpoints.
- Implement access edges with managed identity and least-privilege RBAC.
- Parameterize every contract parameter without embedding secret values.
- Carry every local and deployment-time validation gate into the generated
  workflow or completion report.

After generation, typecheck and dry-run the complete deployment, inspect the
emitted Bicep and azd manifest, and verify that every contract resource,
control, dependency, and output is represented.
