# Workload intent model

Use repository evidence to discover required capabilities before selecting
Azure services.

## Evidence precedence

Use this order when sources disagree:

1. Explicit user requirements and constraints.
2. Executable application behavior and checked-in configuration.
3. Existing production infrastructure and deployment contracts.
4. Tests, documentation, and CI/CD behavior.
5. Framework conventions.
6. Safe, documented defaults.

Do not overwrite a compatible existing architecture merely because a different
Azure service would be preferred for a greenfield workload.

## Signals and likely capabilities

| Repository or prompt signal | Infer this capability | Do not assume |
| --- | --- | --- |
| HTTP routes, web framework, REST, GraphQL, or gRPC server | Request-driven compute and ingress | Public anonymous access |
| Static HTML/CSS/JS build with no server runtime | Static web delivery, CDN, and optional API | A continuously running web server |
| `Dockerfile`, container port, or image build | Container packaging | AKS or microservices |
| Queue-trigger or message-consumer code | Durable asynchronous processing | Which broker, when no client or protocol identifies one |
| Cron expression, timer trigger, or scheduler | Scheduled execution | A continuously running worker |
| Long-running parallel jobs or HPC libraries | Batch execution and job state | Web hosting |
| ORM, migration files, joins, transactions, or SQL driver | Relational persistence | A new database engine different from the current driver |
| MongoDB or document SDK, flexible schemas, partition keys | Document persistence | Relational constraints |
| File uploads, generated media, object keys, or local durable writes | Object storage | Persistent container or App Service local disk |
| Redis client or explicit low-latency ephemeral state | Distributed cache | Durable system of record |
| Full-text index, vector index, retrieval, or RAG pipeline | Managed search or vector retrieval | Search merely because an AI model is used |
| Azure OpenAI, Foundry, model, or agent SDK | AI project and model endpoint | A vector store, agent host, or premium model without evidence |
| WebSocket, SignalR, or bidirectional sessions | Persistent connections and scale-out coordination | Stateless HTTP-only compute |
| OAuth, OpenID Connect, JWT validation, tenant ID, or app roles | Microsoft Entra integration and authorization boundary | A single-tenant or multi-tenant policy not shown in code |
| API keys, client secrets, certificates, or external service credentials | Secret management and rotation | Committing a value to application settings |
| OpenTelemetry, Application Insights, metrics, or trace IDs | Central telemetry and correlation | Existing dashboards and alerts |
| Bot Framework SDK, Teams manifest, or Teams activity handlers | Bot identity, channel registration, and Teams application lifecycle | An AI model when the bot is deterministic |
| Kubernetes manifests, Helm charts, operators, service mesh, or Kubernetes API usage | Kubernetes compatibility requirement | AKS if manifests are only development artifacts |
| Existing Bicep, Terraform, azd, or `iac-compose` source | Existing ownership and deployment model | Permission to replace it |

## Intent record

Keep a concise working record with these fields:

| Field | Contents |
| --- | --- |
| Purpose | Business outcome and primary user journeys |
| Components | Deployable units, runtime, source path, protocol, and lifecycle |
| Ingress | Public, partner, internal, webhook, or no ingress |
| Execution | Request-driven, event-driven, scheduled, worker, batch, or GPU |
| State | Relational, document, object, cache, search, analytics, or none |
| Integration | Commands, events, streams, workflows, and external systems |
| Identity | User identity, workload identity, tenant model, and RBAC boundaries |
| Sensitivity | Secret, personal, regulated, confidential, or public data |
| Operations | Health, telemetry, alerts, backup, restore, and deployment behavior |
| Constraints | Existing engines, protocols, regions, subscriptions, quotas, and budget |
| Profile | `sandbox`, `standard`, or `mission-critical/regulated` |
| Assumptions | Decision, evidence, confidence, impact, and revisit trigger |

For each important conclusion, use one of these confidence levels:

- `explicit`: directly required by the user;
- `evidenced`: supported by code, configuration, or existing infrastructure;
- `defaulted`: a reversible choice made from the workload profile;
- `unresolved`: unsafe to choose without more information.

## Minimal-question policy

Ask only about `unresolved` decisions with material impact. Try these strategies
first:

- preserve the engine or protocol already used by the application;
- expose a deployment parameter instead of fixing a region or capacity;
- choose a reversible starter tier from the workload profile;
- generate but do not deploy a safe placeholder;
- defer optional enhancements that have no supporting evidence.

When a question is unavoidable, state in one short sentence why its answer
controls a safety, compliance, data, recovery, or material-cost decision. Then
ask exactly one focused question.

Questions are justified for:

- data residency or compliance boundaries;
- destructive database or messaging migrations;
- public exposure when code and documentation conflict;
- mission-critical RTO, RPO, or availability requirements;
- sustained GPU, high-performance, or very high-throughput capacity;
- adoption of an expensive fixed-cost service with no clear utilization;
- tenant or identity boundaries that change authorization behavior.

Questions are not justified merely to choose:

- resource names and suffixes;
- common tags;
- managed identity versus stored Azure credentials;
- TLS and HTTPS enforcement;
- basic application telemetry;
- default log retention for a nonregulated workload;
- an initial autoscale range that remains parameterized;
- how to split authored `iac-compose` files.

## Dependency graph

Before generating IaC, identify:

1. shared resources used by more than one component;
2. each component's owned compute and data;
3. identity principals produced by compute;
4. RBAC scopes consumed by those principals;
5. outputs consumed as runtime settings;
6. interactive or application deployment actions that follow provisioning.

Avoid hidden coupling. If component B consumes an output from component A,
provision A first and represent the output explicitly.

## Implementation handoff

Once intent, profile, and dependencies are stable, emit
`implementation-contract.json` using the implementation contract reference.
The contract records the final workload-specific graph and iac-compose
authoring route. It does not record how the design was discovered.

If internal reference matching informed the design, translate it into
customer-evidence-based services, controls, assumptions, and tradeoffs. Do not
include the matched example, catalog metadata, source provenance, or candidate
scores.

## Sparse-request examples

### "Deploy this Node API to Azure"

If the repository shows an Express API, Dockerfile, upload routes, Cosmos DB
SDK, and no Kubernetes-specific behavior, infer:

- request-driven container compute on App Service;
- Azure Container Registry;
- Blob Storage for durable uploads;
- Cosmos DB for the existing document data;
- managed identity and scoped data-plane roles;
- Application Insights and Log Analytics;
- a `standard` profile unless development-only evidence exists.

Do not add AKS, API Management, Front Door, Key Vault, or a virtual network
without an additional capability that needs them.

### "Process documents whenever users upload them"

If code shows Blob triggers and short stateless handlers, infer Blob Storage,
Azure Functions, managed identity, telemetry, and retry/dead-letter behavior
appropriate to the trigger. Add Event Grid or Service Bus only when the
delivery, fan-out, ordering, or isolation requirements justify it.

### "Host our internal RAG assistant"

If code shows a web/API component, model SDK, vector indexing, and document
ingestion, infer application compute, Azure AI Foundry, a model deployment,
Azure AI Search, object storage, identity/RBAC, configuration, and monitoring.
Add Key Vault only for credentials that cannot use managed identity. Infer
internal authentication from repository evidence, but ask if public and
internal exposure signals conflict.
