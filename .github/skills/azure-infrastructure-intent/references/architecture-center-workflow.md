# Internal architecture matching workflow

Use the checked-in Azure Architecture Center catalog as private decision
support. Customers describe outcomes and constraints; they must not need to
know, select, or see reference-example names.

## Output boundary

The catalog, candidate list, match score, source paths, titles, IDs, URLs,
commits, and official implementation links are internal reasoning inputs.
They never belong in the implementation contract or generated infrastructure.
Unless the user explicitly asks for a separate provenance report:

- do not mention Azure Architecture Center or a reference architecture;
- do not say that the workload "matches," "uses," or is "based on" an example;
- do not put reference metadata in plans, implementation contracts, source,
  status files, comments, or completion reports;
- do not ask the user to choose among examples;
- explain every decision from prompt or repository evidence and the selected
  workload profile.

Using a service name such as Azure App Service is expected. Exposing the
reference example that informed the choice is not.

## Internal matching

Build the workload intent model before consulting the catalog. Then compare
candidate examples on capabilities rather than words or products:

1. purpose and primary user journey;
2. component shape and ingress;
3. request, event, scheduled, batch, streaming, or GPU execution;
4. data semantics and existing engines;
5. integration, identity, and trust boundaries;
6. availability, recovery, compliance, scale, latency, and cost profile;
7. existing application and infrastructure constraints.

Shortlist only credible candidates. Product overlap is a weak signal and never
overrides incompatible data semantics, protocols, criticality, or repository
evidence. A request can match no example, and multiple examples can contribute
different proven patterns.

For the best candidate, read its full pinned content. Catalog card metadata is
not a deployable topology and can omit identities, DNS, diagnostics, role
assignments, application code, and supporting resources. Inspect an official
implementation internally when one exists, but verify its license, versions,
scope, and current behavior before reusing code.

## Adapt without exposing the source

Use the candidate as a completeness checklist, not as authority over the
customer's workload:

- retain only capabilities supported by prompt or repository evidence;
- add controls required by the selected workload profile;
- preserve existing compatible engines, protocols, and topology;
- do not promote a proof-of-concept topology to production without adding the
  missing production controls;
- do not weaken a production baseline merely to fit a generator;
- record externally visible assumptions and tradeoffs in workload terms.

Keep any transient candidate notes out of authored files. Attribution required
by a reused code license is the only exception; include the minimum legally
required notice without presenting the example as a customer choice.

## Produce the implementation contract

Translate the final adapted resource graph into
`implementation-contract.json` using
[the implementation contract format](implementation-contract.md). The contract
must be sufficient for iac-compose to choose contract-driven or direct
authoring without repeating architecture discovery.

The contract exposes:

- workload profile, components, services, ownership, and lifecycle;
- resource configuration and Well-Architected controls;
- supported iac-compose kinds or direct ARM resource types;
- outputs, consumers, dependencies, identities, and RBAC;
- parameters, assumptions, tradeoffs, blockers, and validation gates.

It must not expose:

- catalog IDs or titles;
- reference URLs, source commits, or content paths;
- official implementation URLs;
- candidate scores or alternative examples;
- fields named `referenceArchitecture`, `architectureCenter`, `sourceCommit`,
  or `officialImplementationUrls`.

Before handing off, search the contract and response for those fields and for
the selected example's identifying text. If provenance was requested, report
it separately after the contract is complete.
