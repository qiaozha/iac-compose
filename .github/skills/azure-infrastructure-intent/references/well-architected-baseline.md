# Azure Well-Architected baseline

Apply this baseline after recognizing workload intent and again after generating
IaC. Architecture quality is a balance across reliability, security, cost
optimization, operational excellence, and performance efficiency.

## Workload profiles

### Sandbox

Use for prototypes, demos, personal projects, and development-only
environments.

- Single region and the smallest compatible managed or consumption tier.
- Scale to zero when the runtime and latency requirements allow it.
- Public ingress only for endpoints that users or integrations need.
- Identity, HTTPS, secret isolation, and basic telemetry remain mandatory.
- Avoid private networking, zone redundancy, premium gateways, and
  multi-region resources unless the workload specifically needs them.
- Use shorter diagnostic retention and low-cost storage redundancy.
- Document that the environment is not production resilient.

### Standard

Use for ordinary business workloads and as the default when evidence does not
indicate a sandbox or mission-critical system.

- Single-region managed PaaS with production-capable tiers.
- Horizontal autoscaling for stateless compute where supported.
- Zone redundancy when supported in the chosen region and justified against
  its incremental cost.
- Health probes, graceful restart, backup, restore, and soft-delete behavior
  for durable state.
- Managed identity and RBAC for service-to-service access.
- Restrict data-plane networking. Use private endpoints for sensitive data or
  explicit network-isolation requirements; otherwise use identity, firewalls,
  and a documented public-access tradeoff.
- Central logs, metrics, traces, diagnostics, actionable alerts, and defined
  retention.
- Parameterized capacity so measured usage can drive right-sizing.

### Mission-critical or regulated

Use only with explicit business, policy, or repository evidence.

- Confirm data residency, availability target, RTO, RPO, and failover ownership
  before a real deployment.
- Use availability zones and a tested multi-region strategy where the service
  and business objectives require them.
- Eliminate single points of failure across compute, data, identity,
  networking, DNS, and deployment paths.
- Use private connectivity, controlled ingress and egress, WAF or network
  inspection, and policy enforcement according to the threat model.
- Configure geo-redundant backup or replication, recovery automation, and
  regular restore or failover tests.
- Separate production from lower environments and enforce least privilege,
  change control, diagnostics, alerting, and immutable audit retention.
- Treat premium fixed-cost services as explicit, reviewed tradeoffs.

Do not label a design mission-critical merely because it uses expensive SKUs.

## Universal controls

Apply these unless the resource does not support them or a documented tradeoff
explains the deviation:

- deterministic, collision-safe naming that follows existing repository or
  Cloud Adoption Framework conventions;
- common tags for application, environment, owner or team when known, and cost
  grouping;
- HTTPS-only and a minimum TLS version of 1.2 or higher where configurable;
- Microsoft Entra ID, managed identity, and least-privilege RBAC instead of
  stored Azure credentials;
- local or shared-key authentication disabled where all clients support
  identity-based access;
- secrets and certificates in Key Vault or an approved external secret store;
- encryption at rest and in transit;
- health endpoints and platform health probes for hosted applications;
- Application Insights or OpenTelemetry correlation for application compute;
- Log Analytics and diagnostic settings for operationally important platform
  and data resources;
- backup, retention, soft delete, and tested restore behavior for durable
  state;
- explicit public ingress and data-plane exposure decisions;
- deployment outputs for endpoints, identities, resource IDs, and names that
  consumers need.

Do not create Key Vault when the workload has no secret or certificate
capability. Do not expose a secret as an IaC output.

## Pillar gate

Use this matrix for the intended architecture and the emitted IaC.

| Pillar | Required review | IaC evidence |
| --- | --- | --- |
| Reliability | Failure modes, dependency outages, zones, backups, restore, RTO/RPO, health, retries, and failover | Replica or zone settings, probes, backup/retention, soft delete, autoscale, recovery configuration |
| Security | Identity boundaries, least privilege, secrets, encryption, public exposure, threat protection, and audit | Managed identities, scoped role assignments, TLS, local-auth settings, network ACLs/private endpoints, Key Vault, diagnostics |
| Cost optimization | Every resource justified, starter capacity right-sized, elasticity, retention, environment tiers, and idle cost | Parameterized SKUs/capacity, autoscale or scale-to-zero, retention values, no unexplained premium resources |
| Operational excellence | Repeatable deployment, observability, safe release, incident response, and configuration ownership | Authored IaC, ordered layers, telemetry, diagnostic settings, alerts, action group, explicit outputs |
| Performance efficiency | Scaling unit, concurrency, quotas, partitions, hot spots, latency, and load validation | Scale rules, partition counts/keys, throughput parameters, caching only when evidenced, regional placement |

Fail the gate when a universal control is absent without explanation. A dry run
that compiles successfully is not sufficient evidence of architectural
quality.

## Tradeoff record

For each meaningful deviation or profile choice, record:

| Field | Meaning |
| --- | --- |
| Decision | What the architecture does |
| Evidence | User requirement, repository signal, or profile default |
| Benefit | Pillar or capability improved |
| Cost | Money, complexity, latency, availability, or operational burden added |
| Risk accepted | What remains weaker |
| Revisit trigger | Usage, incident, policy, scale, or business event that changes the decision |

Examples:

- A sandbox uses public data endpoints restricted by identity and firewall to
  avoid private networking cost and complexity; revisit before production.
- A standard workload remains single-region because no cross-region RTO exists;
  revisit when the business defines a regional outage objective.
- A steady worker uses provisioned compute instead of scale-to-zero because
  measured utilization makes it cheaper and avoids cold starts.

## Pairing checks

Review connected resources together:

- compute identity has the required data-plane role at the narrowest scope;
- private endpoints have matching private DNS zones and network links;
- compute has a route to private data resources;
- Function storage is compatible with its hosting and networking plan;
- selected SKUs support required VNet, zone, backup, and autoscale features;
- storage redundancy aligns with compute zone and recovery choices;
- database consistency, replication, and throughput settings are compatible;
- Key Vault purge protection is enabled when it protects durable production
  data or customer-managed keys;
- public edge services forward only to intended origins;
- diagnostic destinations exist before diagnostic settings are created.

## Region and SKU rules

- Keep the application region parameterized until deployment context is known.
- Choose regions from data residency, latency, service availability, paired
  region strategy, quota, and cost evidence.
- Verify availability-zone and feature support in the selected region.
- Prefer stable generally available service tiers and API versions.
- Start with the smallest tier that satisfies required features, not simply the
  cheapest tier.
- Do not use a development tier when a required feature such as VNet
  integration, zone redundancy, private link, autoscale, or SLA needs a higher
  tier.

## Official references

- [Azure Well-Architected Framework pillars](https://learn.microsoft.com/azure/well-architected/pillars)
- [Azure application design principles](https://learn.microsoft.com/azure/architecture/guide/design-principles/)
- [Cloud Adoption Framework naming guidance](https://learn.microsoft.com/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming)
- [Cloud Adoption Framework tagging guidance](https://learn.microsoft.com/azure/cloud-adoption-framework/ready/azure-best-practices/resource-tagging)
