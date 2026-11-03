# Foundry in cs336

Define a Microsoft Foundry account, project, and DeepSeek model deployment in
TypeScript with iac-composer.

| Setting | Value |
| --- | --- |
| Subscription | `9dbc8298-39f2-4fca-bbec-e8af850c1bc0` |
| Existing resource group | `cs336` |
| Foundry region | `westus2` |
| Account | `cs336-foundry-<deterministic resource-group suffix>` |
| Project | `cs336-project` |
| Model deployment | `deepseek-v4-1-flash` |
| Model format / name / version | `DeepSeek` / `DeepSeek-V4.1-Flash` / `2026-09-10` |
| Deployment SKU | `GlobalStandard` |
| Requested capacity | `50` units = `50,000` tokens per minute |
| Version upgrade policy | `NoAutoUpgrade` |
| Deployer access | `Foundry Project Manager`, scoped to the Foundry account |

## Resources

[infra.ts](./infra.ts) uses the Azure JavaScript provisioning libraries to define:

- `Microsoft.CognitiveServices/accounts`: kind `AIServices`, SKU `S0`,
  system-assigned identity, project management enabled, and a custom subdomain.
- `Microsoft.CognitiveServices/accounts/projects`: a child project with its own
  system-assigned identity. Its parent reference establishes deployment ordering.
- `Microsoft.CognitiveServices/accounts/deployments`: a DeepSeek-V4.1-Flash
  deployment under the same account. The project and model deployment both depend
  on the account; the model is account-scoped, not a child of the project.
  Model provisioning also waits for the project to avoid concurrent child
  updates, which Cognitive Services can reject with `RequestConflict`.
- `Microsoft.Authorization/roleAssignments`: Foundry Project Manager
  (`eadc314b-1a2d-4efa-be10-5d325db5065e`) for the identity performing the azd
  deployment, scoped only to the Foundry account and inherited by its projects.
  The assignment name is deterministic for the account, principal, and role.

The model name, version, format, and SKU were verified against Azure's `westus2`
model catalog. This is the direct-from-Azure model, not the Fireworks variant.
It is a Preview model, and the catalog lists December 15, 2026 as its deprecation
date. Review availability and the retirement schedule before provisioning.
The version is explicitly pinned; no automatic version upgrade is requested.

The public endpoint is enabled, but API-key authentication is disabled.
Clients must authenticate with Microsoft Entra ID and have appropriate Foundry
data-plane RBAC permissions. The deployer receives Foundry Project Manager,
which provides Foundry data access, project management, and limited role
delegation. No new resource-group or subscription-wide role is granted.

The parameter file consumes azd's automatically supplied `AZURE_PRINCIPAL_ID`
during provisioning. The deployment program resolves Azure CLI's signed-in
account type and explicitly supplies `AZURE_PRINCIPAL_TYPE` because some azd
versions do not inject it. Azure CLI and azd must authenticate as the same
deployment identity; the delegated CLI-auth configuration below ensures this.
These values identify the deployment user or service principal, not the account
or project managed identity.
No user object ID is hard-coded into the infrastructure. Both values are required;
the allowed principal types are `User` and `ServicePrincipal`.
The azd principal ID compilation variable need not appear in persisted
`azd env` values. Missing or unsupported account types fail before provisioning.
Using a different deployment identity creates a distinct role assignment; it
does not revoke previously granted access.

No separate Storage, Cosmos DB, AI Search, Key Vault, Container Registry,
Application Insights, or capability host is created. These
are not required for this account, project, and model definition. Add resources
when a concrete workload needs them; for example, hosted agents need additional
setup, and bring-your-own agent data storage needs connections and role grants.

## Install and preview

Run the following from the repository root with Node.js 20.6 or newer.
The provisioning dependencies use the repository's bundled `0.1.0` packages,
so installing this example does not need access to private GitHub release assets.

```bash
npm ci
npm run build
npm --prefix examples/foundry ci
./node_modules/.bin/tsc -p examples/foundry/tsconfig.json
npm run iac-composer -- ./examples/foundry/deploy.ts --environment cs336 --dry-run
```

The dry run compiles the authored TypeScript into
[.generated/foundry/](./.generated/foundry/) and prepares a local azd manifest.
It does not execute Azure CLI or azd commands, authenticate, grant roles, or
provision resources. Generated files and local azd state are ignored by Git.
Edit the TypeScript sources, not generated Bicep.

Optionally compile the generated Bicep locally with an installed Bicep CLI:

```bash
az bicep build --file examples/foundry/.generated/foundry/main.bicep --stdout > /dev/null
```

The bundled SDK emits the documented `2026-07-01` Cognitive Services API.
Older Bicep compilers may report `BCP081` because they do not have its resource
schemas. Compilation still succeeds, but those compilers cannot validate
resource properties against that API's schema.

## Deploy only after approval

[deploy.ts](./deploy.ts) pins the subscription, existing resource group, and
selected region, independently of your default Azure CLI subscription.
It checks access to the existing resource group before provisioning and does
not create the resource group.

Before a real deployment:

1. Authenticate Azure CLI and azd to the tenant containing the target subscription.
2. Verify that `cs336` exists and that you can read it.
3. Ensure `Microsoft.CognitiveServices` is registered and that you have permission
   to create accounts and projects in `cs336` and
   `Microsoft.Authorization/roleAssignments/write` at the Foundry account scope.
   Subscription registration, if
   needed, is a separate administrator action.
4. Confirm model availability and applicable Azure policies in `westus2`.
5. Verify at least `50` unallocated capacity units for
   `AIServices.GlobalStandard.DeepSeek-V4.1-Flash` in the target subscription.
   Catalog availability does not establish subscription quota. Capacity units
   are not raw TPM: requesting `50,000` units would request `50,000,000` TPM,
   not the selected `50,000` TPM.
6. Review the model's Preview status and deprecation date, the generated template,
   and Azure charges before approving deployment.

After approval, run from the repository root:

```bash
AZURE_DEV_USER_AGENT=microsoft_foundry_skill npm run iac-composer -- ./examples/foundry/deploy.ts --environment cs336
```

If Azure CLI can access the subscription but azd has a stale login, azd can reuse
the interactive `az login` session. Keep this setting local to the generated
project rather than changing global azd configuration:

```bash
AZD_CONFIG_DIR="$PWD/examples/foundry/.generated/.azd-cli-auth" \
  AZURE_DEV_USER_AGENT=microsoft_foundry_skill azd config set auth.useAzCliAuth true
AZD_CONFIG_DIR="$PWD/examples/foundry/.generated/.azd-cli-auth" \
  AZURE_DEV_USER_AGENT=microsoft_foundry_skill npm run iac-composer -- ./examples/foundry/deploy.ts --environment cs336
```

The only supported component selector is `--component foundry`; unknown
components fail before commands or provisioning.

## Outputs

iac-composer obtains the outputs through azd, which persists them in the ignored
local environment under [.generated/.azure/](./.generated/.azure/).
The program then publishes them to subsequent steps in the same process.

- `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_AI_LOCATION`
- `AZURE_AI_ACCOUNT_ID`, `AZURE_AI_ACCOUNT_NAME`
- `AZURE_AI_PROJECT_ID`, `AZURE_AI_PROJECT_NAME`, `AZURE_AI_PROJECT_ENDPOINT`
- `AZURE_AI_MODEL_DEPLOYMENT_ID`, `AZURE_AI_MODEL_DEPLOYMENT_NAME`
- `AZURE_FOUNDRY_ROLE_ASSIGNMENT_ID`, `AZURE_FOUNDRY_PRINCIPAL_ID`

The project endpoint is read from the resource's `endpoints['AI Foundry API']`
output, not constructed from a hard-coded Azure hostname.
Use `AZURE_AI_MODEL_DEPLOYMENT_NAME` (`deepseek-v4-1-flash`) as the model/deployment
identifier in inference requests rather than the catalog model name.

Local validation cannot establish subscription access, policy compliance,
regional capacity, or successful provisioning. No Azure deployment is performed
by the preview commands above.

## References

- [Foundry account resource reference](https://learn.microsoft.com/azure/templates/microsoft.cognitiveservices/accounts)
- [Foundry project resource reference](https://learn.microsoft.com/azure/templates/microsoft.cognitiveservices/accounts/projects)
- [Model deployment resource reference](https://learn.microsoft.com/azure/templates/microsoft.cognitiveservices/accounts/deployments)
- [DeepSeek-V4.1-Flash model card](https://ai.azure.com/catalog/models/DeepSeek-V4.1-Flash)
- [Foundry role-based access control](https://learn.microsoft.com/azure/ai-foundry/concepts/rbac-ai-foundry)
