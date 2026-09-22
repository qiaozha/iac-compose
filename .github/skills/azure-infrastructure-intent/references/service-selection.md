# Azure service selection

Choose services from workload capabilities and repository evidence. Confirm
current regional availability, quotas, supported features, and stable API
versions before a real deployment.

The `iac-compose` mapping identifies whether the contract generator has a
logical kind. `Direct` means author the Azure resource in a TypeScript
provisioning entrypoint and still orchestrate it with `iac-compose`.

## Compute

| Workload evidence | Preferred starting service | `iac-compose` mapping | Change the choice when |
| --- | --- | --- | --- |
| Static SPA or site with no persistent server | Azure Static Web Apps | Direct | Enterprise edge controls require Front Door, or the existing app already uses another static host |
| Conventional web app or API, especially an existing framework | Azure App Service | `container-host` for the supported container path; otherwise direct | Scale-to-zero, revision traffic, or event scaling favors Container Apps |
| Containerized API, worker, or microservice needing revisions or scale-to-zero | Azure Container Apps | Direct | Kubernetes API/control-plane access is required, or a simple existing web app fits App Service |
| Short event-driven or scheduled handler | Azure Functions | Direct | The task is long-running, requires a custom runtime not supported by the plan, or is better modeled as a Container Apps job |
| Scheduled or finite container job | Azure Container Apps Jobs | Direct | It is massively parallel HPC/batch, which favors Azure Batch |
| Kubernetes-native platform with operators, custom networking, service mesh, or direct Kubernetes API requirements | AKS | Direct | The only signal is a Dockerfile or multiple containers |
| Legacy workload requiring OS access or lift-and-shift | Azure Virtual Machines or VM Scale Sets | Direct | The application can move to a managed platform without an unsafe redesign |
| Large parallel or HPC job | Azure Batch | Direct | It is an ordinary queue worker or scheduled task |

Evaluate each deployable component separately. Prefer a managed service with
lower operational overhead when two options meet the same requirements.

## Data, configuration, and secrets

| Required capability | Preferred starting service | `iac-compose` mapping | Selection notes |
| --- | --- | --- | --- |
| Durable files, uploads, media, or object payloads | Azure Blob Storage | `object-storage` | Keep application local disk ephemeral; select redundancy from the workload profile |
| Flexible document data, partitioned state, or globally distributed document access | Azure Cosmos DB for NoSQL | `document-database` | Validate partition key, consistency, throughput mode, and region topology |
| Existing SQL Server semantics or T-SQL ecosystem | Azure SQL Database | Direct | Preserve engine compatibility; use Entra authentication where supported |
| Existing PostgreSQL application | Azure Database for PostgreSQL Flexible Server | Direct | Preserve extensions, collation, HA, backup, and connection requirements |
| Existing MySQL application | Azure Database for MySQL Flexible Server | Direct | Preserve engine/version compatibility and backup requirements |
| Nonsecret runtime configuration and feature settings | Azure App Configuration | `configuration-store` | Use references or identities rather than copying secrets into values |
| Secrets, certificates, or external credentials | Azure Key Vault | Direct | Use RBAC, soft delete, purge protection for protected workloads, and managed identity access |
| Ephemeral shared cache or distributed session state | Azure Managed Redis | Direct | Do not use a cache as the system of record |
| Full-text, vector, or RAG retrieval | Azure AI Search | Direct | Add only when indexing or retrieval behavior exists |
| Central analytics lake | Azure Data Lake Storage Gen2 | Direct | Add analytics engines only from actual query, transformation, or governance needs |

Do not migrate a database engine solely to simplify IaC. Database migration is
a separate application and data decision.

## Messaging and integration

| Interaction | Preferred starting service | `iac-compose` mapping | Selection notes |
| --- | --- | --- | --- |
| Durable commands, work queues, topics, ordering, duplicate detection, transactions, or sessions | Azure Service Bus | Direct | Default enterprise broker for reliable application messaging |
| Reactive event notification and fan-out | Azure Event Grid | Direct | Events describe facts; consumers must tolerate retries and duplicates |
| High-throughput telemetry or ordered event streams | Azure Event Hubs | Direct | Plan partitions, retention, consumer groups, and throughput |
| Very simple low-cost work queue tied to Storage | Azure Queue Storage | Direct | Use only when advanced broker features are unnecessary |
| SaaS and enterprise workflow orchestration | Azure Logic Apps | `workflow-host` and `authorized-api-connection` for supported templates; otherwise direct | Interactive connectors need an authorization lifecycle |
| Real-time client fan-out | Azure SignalR Service or Web PubSub | Direct | Add for multi-instance connection scale, not for ordinary HTTP |

Do not use a message broker when synchronous request/response is simpler and
meets reliability requirements. Do use asynchronous decoupling when producers
must survive consumer outages or components scale independently.

## AI and search

| Capability | Preferred starting service | `iac-compose` mapping |
| --- | --- | --- |
| Managed model inference and project isolation | Azure AI Foundry project | `ai-project` |
| Explicit model and version deployment | Foundry model deployment | `model-deployment` |
| Hosted agent component | Foundry hosted agent plus its container source | `ai-project`, `model-deployment`, and hosted `container-host` |
| Retrieval over indexed enterprise content | Azure AI Search | Direct |
| Document extraction or OCR | Azure AI Document Intelligence | Direct |
| Speech input or output | Azure AI Speech | Direct |

Select a model, capacity, and region only after confirming availability and
quota. Parameterize `AZURE_AI_LOCATION` separately from the application region
when required.

## Teams and conversational applications

| Capability | Preferred starting service | `iac-compose` mapping |
| --- | --- | --- |
| Bot Framework identity and Teams channel | Azure Bot Service with managed identity | `bot-identity` |
| Teams application package and environment-specific manifest values | Microsoft Teams application lifecycle | `teams-application` |
| Teams connector used by a Logic Apps workflow | Authorized API connection | `authorized-api-connection` |

Add these resources only when the application actually uses the corresponding
channel or connector. A conversational interface does not by itself require an
AI model.

## Edge, API, and networking

Add these only when the workload needs the capability:

| Need | Service | Notes |
| --- | --- | --- |
| Global HTTP entry, CDN, acceleration, or global failover | Azure Front Door | Add WAF for protected public production workloads |
| Regional layer-7 ingress into a virtual network | Application Gateway | Use a dedicated subnet and WAF where threat exposure warrants it |
| API products, subscriptions, policy, transformation, throttling, or developer portal | API Management | Not a default wrapper for every API |
| Private PaaS data plane | Private Endpoint and Private DNS zone | Include DNS links and compute-side VNet integration |
| Controlled centralized egress or network inspection | NAT Gateway or Azure Firewall | Choose from actual egress and inspection requirements |
| Hybrid connectivity | VPN Gateway or ExpressRoute | Requires on-premises topology and address-space inputs |

Public ingress can be correct for a user-facing application. Public data-plane
access should be minimized and justified. A private endpoint is incomplete
without DNS and a network path from the consuming compute.

## Cross-cutting resources

Add supporting resources when their capability exists:

- a managed identity for workload-to-Azure authentication;
- least-privilege Azure RBAC assignments;
- Azure Container Registry for private container images
  (`container-registry`, or the registry generated with supported
  `container-host` resources);
- Application Insights and Log Analytics for application telemetry;
- diagnostic settings for important platform and data resources;
- alert rules and an action group for production operator signals;
- backup, retention, soft-delete, and restore configuration for durable state;
- consistent tags for application, environment, ownership, and cost grouping.

The contract kind `application-monitoring` provides the supported Application
Insights path. Use direct authoring when the profile requires diagnostic
settings or alerting beyond the generated contract.

## Selection anti-patterns

- Choosing AKS because the repository contains a Dockerfile.
- Adding APIM, Front Door, Firewall, or a virtual network with no capability or
  risk that needs it.
- Choosing serverless for a steady high-utilization workload without comparing
  cost and limits.
- Keeping public access on every data service merely to avoid DNS work.
- Adding private endpoints without private DNS and compute network integration.
- Replacing a relational engine with a document database without changing the
  data model deliberately.
- Selecting premium or multi-region tiers before the workload profile justifies
  them.
- Using connection strings or account keys where managed identity and RBAC are
  supported.
- Assuming generator defaults are production-ready without inspecting emitted
  IaC.

## Official decision references

- [Azure compute decision tree](https://learn.microsoft.com/azure/architecture/guide/technology-choices/compute-decision-tree)
- [Azure Architecture Center](https://learn.microsoft.com/azure/architecture/)
- [Azure service comparison guidance](https://learn.microsoft.com/azure/architecture/guide/technology-choices/)
