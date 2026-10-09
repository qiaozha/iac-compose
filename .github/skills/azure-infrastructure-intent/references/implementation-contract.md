# Implementation contract

`implementation-contract.json` is the stable handoff from workload intent to
iac-compose. It describes the final customer-specific design without exposing
internal reference material.

The contract must validate against
[`implementation-contract.schema.json`](implementation-contract.schema.json).
The repository's complete human-readable field reference and validated
examples are in
[`docs/implementation-contract.md`](../../../../docs/implementation-contract.md).

## Required top-level fields

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Contract version; currently `1.0` |
| `solution` | Stable solution name |
| `profile` | `sandbox`, `standard`, or `mission-critical/regulated` |
| `authoringMode` | Final `contract`, `direct`, or deliberate `hybrid` route |
| `components` | Deployable application units, lifecycle, and source when available |
| `resources` | Azure services, ownership, implementation route, and controls |
| `parameters` | Required deployment inputs, with secret classification |
| `dependencies` | Producer-to-consumer output and ordering edges |
| `deploymentOrder` | Ordered component or shared-layer IDs |
| `assumptions` | Decisions with evidence and confidence |
| `wellArchitected` | Decisions for all five pillars |
| `tradeoffs` | Accepted costs and revisit triggers |
| `validation` | Local and deployment-time gates |
| `unresolved` | Blocking decisions; empty when implementation can proceed |

## Resources

Every resource contains:

- `id`, `service`, `capability`, `requiredBy`, and `ownership`;
- `implementation.mode`;
- `implementation.kind` for a supported contract resource;
- `implementation.azureResourceTypes` for direct authoring;
- `configuration` and `controls` that preserve the selected profile;
- `produces`, `consumes`, and `access` where applicable.

Use exact supported kind and output names from the iac-compose contract. Do not
invent a logical kind for an unsupported service. Direct resources name their
provider-qualified ARM types instead.

`authoringMode` is `contract` only when every resource and required property is
supported. Prefer `direct` for a mixed graph unless the repository already has
a safe hybrid ownership pattern.

## Examples

The repository includes complete, schema-valid examples:

- [contract-driven container API](../../../../docs/examples/implementation-contract.contract.json);
- [directly authored static site](../../../../docs/examples/implementation-contract.direct.json).

Use them for shape and graph conventions only. Infer services, controls, and
profile from the actual customer workload.

## Privacy check

Before writing the contract, verify that it contains no catalog title, ID,
reference URL, source commit, candidate score, or official sample URL. Reasons
must cite workload evidence, not the hidden matching process.
