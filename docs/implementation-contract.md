# Implementation contract schema

`implementation-contract.json` is the boundary between Azure workload intent
recognition and infrastructure authoring. It records the final,
customer-specific resource graph that iac-compose must implement.

The contract answers:

- which application components exist and how they run;
- which Azure capabilities and controls each component requires;
- which resources are shared or component-owned;
- which values, identities, and permissions connect resources;
- whether iac-compose can use generated resource contracts or must author the
  resources directly;
- which assumptions, tradeoffs, blockers, and validation gates remain.

It does **not** record how the architecture was discovered. Internal reference
matches, catalog identifiers, source URLs, commits, candidate scores, and sample
repositories are excluded.

## Canonical files

- Machine-readable schema:
  [`implementation-contract.schema.json`](../.github/skills/azure-infrastructure-intent/references/implementation-contract.schema.json)
- Contract-driven example:
  [`implementation-contract.contract.json`](examples/implementation-contract.contract.json)
- Direct-authoring example:
  [`implementation-contract.direct.json`](examples/implementation-contract.direct.json)

The schema uses JSON Schema draft 2020-12. The only supported contract version
is currently `1.0`. Consumers must reject unsupported versions instead of
guessing their meaning.

## Where the contract fits

The implementation contract is not an input accepted directly by the
`iac-compose generate` CLI. It is the intent handoff from which the iac-compose
skill selects and authors one of these workflows:

| `authoringMode` | iac-compose result |
| --- | --- |
| `contract` | Translate supported resources into `config/resource-requirements.json` and `solution.json`, then run `iac-compose generate`. |
| `direct` | Author TypeScript provisioning entrypoints and an ordered deployment program. |
| `hybrid` | Combine the two only when ownership is unambiguous and the repository already supports the pattern. |

The implementation contract should remain checked in as the explanation of
what the infrastructure must implement. Generated Bicep and `azure.yaml` remain
artifacts.

## Top-level object

The root object rejects unknown properties. Every field in this table is
required, although several arrays may be empty.

| Field | Type | Empty allowed | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | string constant | No | Must be `"1.0"`. |
| `solution` | object | No | Stable solution identity. |
| `profile` | enum | No | Workload criticality and baseline controls. |
| `authoringMode` | enum | No | Final iac-compose authoring route. |
| `components` | component array | No | At least one deployable or lifecycle-owning component. |
| `resources` | resource array | No | At least one required Azure resource or logical service. |
| `parameters` | parameter array | Yes | Deployment inputs; values are not stored here. |
| `dependencies` | dependency array | Yes | Output-based resource graph edges. |
| `deploymentOrder` | string array | No | Ordered component/shared-layer execution. |
| `assumptions` | assumption array | Yes | Evidence-qualified decisions that can be revisited. |
| `wellArchitected` | object | No | Decisions for all five Well-Architected pillars. |
| `tradeoffs` | tradeoff array | Yes | Explicitly accepted costs or risks. |
| `validation` | validation array | No | At least one local or deployment-time gate. |
| `unresolved` | blocker array | Yes | Blocking decisions; must be empty before implementation. |

### `solution`

```json
{
  "name": "orders-api"
}
```

`name` is a non-empty stable identifier for the whole solution. It is used to
derive deployment package names and resource naming inputs. Environment names
do not belong here; declare them as parameters.

Unknown `solution` properties are rejected.

### `profile`

Allowed values:

| Value | Use |
| --- | --- |
| `sandbox` | Demonstrations, experiments, personal projects, and development-only workloads. |
| `standard` | Ordinary business and production workloads without stronger criticality evidence. |
| `mission-critical/regulated` | Workloads with explicit availability, recovery, residency, or compliance requirements. |

The profile controls required reliability, networking, observability, backup,
security, scaling, and cost decisions. It does not replace service-specific
configuration in `resources[].controls` or `resources[].configuration`.

### `authoringMode`

Allowed values:

- `contract`: every resource uses `implementation.mode: "contract"`, and every
  required property is expressible by a supported iac-compose resource kind.
- `direct`: every resource is implemented in authored TypeScript and declares
  `implementation.mode: "direct"`.
- `hybrid`: the resources deliberately mix `contract` and `direct` modes.

If a supported kind cannot express one required network, security, backup,
availability, scaling, or diagnostics control, use direct authoring rather than
weakening the contract.

The JSON Schema validates the enum but cannot enforce consistency between the
top-level mode and every resource. Consumers must perform that semantic check.

## Components

Each component represents an application unit or lifecycle owner.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique non-empty component identifier. |
| `kind` | Yes | Component role, such as `http-api`, `worker`, `static-site`, or `hosted-agent`. |
| `lifecycle` | Yes | Execution shape, such as `request-driven`, `event-driven`, `scheduled`, or `batch`. |
| `source` | When application deployment is required | Source directory relative to the solution package. |
| `runtime` | No | Runtime family, for example `node`, `python`, `container`, or `static`. |
| `protocol` | No | Primary interface, for example `https`, `grpc`, `queue`, or `none`. |

Components permit additional workload-specific properties. Keep them
descriptive; Azure resource configuration belongs under `resources`.

Component IDs must be unique. Every ID referenced by `requiredBy` must exist.

## Resources

Resources are strict objects: unknown resource-level properties are rejected.
Every resource must contain all fields below.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique logical resource identifier. |
| `service` | string | Customer-readable Azure service name. |
| `capability` | string | Workload requirement satisfied by the resource. |
| `requiredBy` | non-empty string array | Component IDs that require the resource. |
| `ownership` | `shared` or `component` | Provisioning and lifecycle owner. |
| `implementation` | tagged object | Contract kind or direct ARM resource types. |
| `configuration` | object | Kind- or service-specific settings required for implementation. |
| `controls` | non-empty string array | Security, reliability, cost, operations, and performance requirements. |
| `produces` | string array | Nonsecret output names made available to consumers. |
| `consumes` | string array | Output names required from other resources. |
| `access` | object array | Identity and permission edges. |

### Identity and ownership

- Use `ownership: "component"` when exactly one component owns the resource.
  That component appears in `requiredBy`.
- Use `ownership: "shared"` when multiple components consume the resource or
  it has a cross-cutting lifecycle.
- Do not infer ownership from the Azure service name.

### `implementation`: contract mode

```json
{
  "mode": "contract",
  "kind": "object-storage"
}
```

The object accepts only `mode` and `kind`. Supported kinds are:

| Kind | Typical Azure capability | Supported output families |
| --- | --- | --- |
| `ai-project` | Foundry project and hosted agent context | `foundryProjectEndpoint`, `agentName`, `agentVersion` |
| `model-deployment` | Foundry model deployment | `foundryModelDeploymentName` |
| `container-registry` | Azure Container Registry | `containerRegistryName`, `containerRegistryEndpoint` |
| `document-database` | Cosmos DB for NoSQL | `cosmosEndpoint`, `cosmosDatabase`, `cosmosAccountName`, `cosmosAccountResourceId` |
| `object-storage` | Blob Storage | `storageBlobEndpoint`, `storageAccountName`, `storageAccountResourceId` |
| `configuration-store` | Azure App Configuration | `appConfigurationEndpoint`, `appConfigurationName`, `appConfigurationResourceId` |
| `application-monitoring` | Application Insights and Log Analytics | `applicationInsightsConnectionString`, `applicationInsightsName` |
| `container-host` | Supported App Service container hosting | Role-specific URL and managed-identity outputs |
| `bot-identity` | Azure Bot and managed identity | `botClientId`, identity outputs, `tenantId` |
| `teams-application` | Teams application lifecycle | `teamsAppId` |
| `authorized-api-connection` | Interactive Logic Apps connection | `teamsConnectionResourceId`, `connectionResourceId` |
| `workflow-host` | Logic Apps workflow | Configured workflow identity output |

Only outputs supported by the selected kind may appear in `produces`.
Kind-specific settings belong in `configuration`; the downstream translation
places them in the exact resource-requirements fields expected by the
generator.

For the complete current output and role vocabulary, see the
[contract workflow](../.github/skills/iac-compose/references/contract-workflow.md#supported-resource-kinds).

### `implementation`: direct mode

```json
{
  "mode": "direct",
  "azureResourceTypes": [
    "Microsoft.Web/staticSites"
  ]
}
```

The object accepts only `mode` and `azureResourceTypes`.
`azureResourceTypes` must contain at least one provider-qualified ARM resource
type matching `Namespace/type`, for example:

- `Microsoft.Sql/servers/databases`;
- `Microsoft.ServiceBus/namespaces/queues`;
- `Microsoft.Web/staticSites`.

List every ARM resource type necessary to implement the capability, including
child configuration, private endpoint, DNS, identity, diagnostic, or role
assignment resources required by the controls. API versions do not belong in
the type string; the direct provisioning source selects them.

### `configuration`

`configuration` is always present, even when empty. Its shape is specific to
the selected kind or direct service. Store desired state, not generated
resource IDs or secret values.

Examples include:

- container names and partition keys;
- source path, container port, health path, and runtime settings;
- SKU, capacity, retention, backup, consistency, or zone settings;
- ingress, authentication, network, and diagnostic configuration.

### `controls`

Controls are mandatory, testable implementation requirements. Avoid vague
phrases such as "secure the service." Prefer statements such as:

- `Minimum TLS 1.2`;
- `Shared-key access disabled`;
- `Zone redundancy enabled`;
- `Thirty-day point-in-time restore`;
- `Private endpoint with linked private DNS zone`;
- `Scale to zero when idle`.

Every control must appear in emitted infrastructure or as an explicit
deployment-time validation. If a contract kind cannot express it, change the
resource to direct mode.

### Outputs and dependencies

`produces` contains nonsecret logical outputs. `consumes` names outputs used by
the resource. Each consumed output must:

1. be produced by exactly one other resource;
2. have one matching `dependencies` entry;
3. be consumed after its producer is provisioned.

Do not output passwords, keys, tokens, connection strings containing
credentials, or certificate material. A service-generated nonsecret endpoint
or an Application Insights connection string is acceptable.

### `access`

Each access entry describes an identity or permission edge. The schema permits
service-specific extensions, but this common shape should be used when
possible:

```json
{
  "principalOutput": "backendIdentityPrincipalId",
  "role": "Storage Blob Data Contributor"
}
```

`principalOutput` must be produced by exactly one declared resource. Use the
narrowest data-plane role and scope. Contract-mode resources must use roles
supported by the resource contract. Direct-mode access may require authored
role assignments or a documented post-provisioning data operation.

## Parameters

Each parameter describes an input, not its value:

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Environment variable or deployment parameter name. |
| `required` | boolean | Whether generation or deployment can proceed without it. |
| `secret` | boolean | Whether its value requires secret handling and redaction. |
| `reason` | string | Why the workload requires the input. |

Never store parameter values in the implementation contract. A field marked
`secret: true` must be read from an approved environment or secret store and
must not become an IaC output.

## Dependency graph and deployment order

A dependency has exactly three fields:

```json
{
  "producer": "uploads",
  "consumer": "apiCompute",
  "via": "storageBlobEndpoint"
}
```

- `producer` and `consumer` are resource IDs.
- `via` is an output in the producer's `produces` array and the consumer's
  `consumes` array.
- Dependencies must form an acyclic provisioning graph.

`deploymentOrder` is the ordered list of component IDs and explicit shared
layer IDs, not individual ARM resources. Put shared layers before components
that consume their outputs. Azure resource dependencies inside one layer remain
the responsibility of the provisioning entrypoint.

## Assumptions

Each assumption requires:

| Field | Meaning |
| --- | --- |
| `decision` | The selected behavior or default. |
| `evidence` | Prompt, repository, existing infrastructure, or profile evidence. |
| `confidence` | `explicit`, `evidenced`, `defaulted`, or `unresolved`. |
| `revisitTrigger` | An event or threshold that requires reconsideration. |

Assumptions permit extra explanatory fields. A genuinely blocking unresolved
decision also belongs in `unresolved`; do not hide blockers only in this array.

## Well-Architected decisions

`wellArchitected` has exactly five required arrays:

- `reliability`;
- `security`;
- `costOptimization`;
- `operationalExcellence`;
- `performanceEfficiency`.

Every array must contain at least one non-empty decision. These are requirements
for the selected workload and profile, not generic descriptions of the pillars.

## Tradeoffs

Each tradeoff requires:

| Field | Meaning |
| --- | --- |
| `decision` | The selected design choice. |
| `benefit` | What the choice improves. |
| `cost` | Money, complexity, latency, availability, or risk added. |
| `revisitTrigger` | The event that invalidates the tradeoff. |

Tradeoffs permit additional explanatory fields.

## Validation

At least one validation entry is required:

```json
{
  "stage": "local",
  "check": "Typecheck the deployment and complete an iac-compose dry run"
}
```

Allowed stages:

- `local`: schema checks, contract validation, typechecking, provisioning
  compilation, generated artifact inspection, tests, and dry runs;
- `deployment`: provider registration, policy, quota, regional feature
  availability, role, connectivity, readiness, backup, and restore checks.

A validation entry describes a measurable gate. It does not claim the check has
already passed.

## Unresolved blockers

Each blocker requires `decision` and `impact`:

```json
{
  "decision": "Authoritative data residency boundary",
  "impact": "A region and replication topology cannot be selected safely"
}
```

The array must be empty before infrastructure authoring or deployment begins.
If it is non-empty, ask one focused question at a time or emit a safe
non-deploying placeholder as directed by the intent workflow.

## Structural versus semantic validation

The JSON Schema validates document shape, required fields, enums, non-empty
arrays, direct ARM type syntax, and unknown-property rules. It cannot validate
cross-field graph semantics.

Before authoring, the consumer must also verify:

1. component and resource IDs are unique;
2. parameter names and produced output names are unique;
3. every `requiredBy` component exists;
4. component-owned resources have one unambiguous owner;
5. `authoringMode` agrees with all resource implementation modes;
6. contract kinds use only supported outputs and roles;
7. direct resources list every required ARM resource type;
8. every consumed output has one producer and one dependency edge;
9. access principals are produced by declared resources;
10. dependencies are acyclic;
11. `deploymentOrder` contains valid, unique component or shared-layer IDs and
    orders producers before consumers;
12. every required control is implementable;
13. `unresolved` is empty before implementation.

Consumers must fail explicitly on violations. They must not silently choose a
service, invent an output, drop a control, or repair a dependency.

## Privacy and secret handling

The contract must not contain:

- internal architecture catalog titles, IDs, URLs, commits, or candidate
  scores;
- official sample or implementation repository URLs;
- credentials, tokens, keys, certificate material, or secret parameter values;
- secret-bearing outputs;
- generated Azure resource IDs that are not known until deployment.

When provenance is explicitly requested, report it separately from the
contract and generated infrastructure.

## Versioning

Consumers must require `schemaVersion: "1.0"` and reject other values. A future
schema version must preserve existing `1.0` behavior or use a different version
identifier. Do not infer compatibility from a numerically similar version.
