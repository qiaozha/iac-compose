# Contract-driven generation

Use this workflow when the requested architecture fits the generator's
supported resource kinds and the user wants a component-oriented deployment
package.

## Inputs

Generation consumes two schema version `1.0` JSON files:

1. **Resource requirements** describe logical resources, ownership, outputs,
   bindings, access, and resource-specific configuration.
2. **Solution** describes application components and, optionally, repeats the
   planned resource IDs and kinds for cross-contract validation.

Paths such as component sources and workflow templates are relative to the
solution package.

### Resource requirements example

```json
{
  "schemaVersion": "1.0",
  "solution": {
    "name": "support-api",
    "enabledComponents": ["api"]
  },
  "resources": [
    {
      "id": "monitoring",
      "kind": "application-monitoring",
      "requiredBy": ["api"],
      "produces": ["applicationInsightsConnectionString"]
    },
    {
      "id": "documents",
      "kind": "object-storage",
      "requiredBy": ["api"],
      "configuration": {
        "containers": ["documents"]
      },
      "produces": [
        "storageBlobEndpoint",
        "storageAccountName",
        "storageAccountResourceId"
      ],
      "access": [
        {
          "principalOutput": "backendIdentityPrincipalId",
          "role": "Storage Blob Data Contributor"
        }
      ]
    },
    {
      "id": "apiCompute",
      "kind": "container-host",
      "requiredBy": ["api"],
      "source": "components/api",
      "containerPort": 8080,
      "healthPath": "/health",
      "configuration": {
        "runtimeSettings": {
          "AZURE_STORAGE_BLOB_ENDPOINT": "${output.storageBlobEndpoint}",
          "APPLICATIONINSIGHTS_CONNECTION_STRING": "${output.applicationInsightsConnectionString}"
        }
      },
      "produces": [
        "backendBaseUrl",
        "backendIdentityPrincipalId"
      ]
    }
  ],
  "outputBindings": {
    "syntax": "${output.<name>}"
  }
}
```

Container component sources must contain a `Dockerfile`.

### Solution example

```json
{
  "schemaVersion": "1.0",
  "customer": {
    "name": "support-api",
    "displayName": "Support API"
  },
  "components": [
    {
      "id": "api",
      "kind": "http-api",
      "source": "components/api"
    }
  ],
  "resources": {
    "contract": "config/resource-requirements.json",
    "planned": [
      {
        "id": "monitoring",
        "kind": "application-monitoring"
      },
      {
        "id": "documents",
        "kind": "object-storage"
      },
      {
        "id": "apiCompute",
        "kind": "container-host"
      }
    ]
  }
}
```

If `resources.planned` is present, it must contain every requirement with the
same ID and kind, and no extras.

## Supported resource kinds

Only declare outputs that the selected kind supports.

| Kind | Important fields | Supported public outputs |
| --- | --- | --- |
| `ai-project` | `configuration.model` | `foundryProjectEndpoint`, `agentName`, `agentVersion` |
| `model-deployment` | `parent` AI project ID; `configuration.model`, `version`, `deploymentName` | `foundryModelDeploymentName` |
| `container-registry` | Access grants as needed | `containerRegistryName`, `containerRegistryEndpoint` |
| `document-database` | `configuration.database`, `throughput`, `containers[]` with `name` and `partitionKey` | `cosmosEndpoint`, `cosmosDatabase`, `cosmosAccountName`, `cosmosAccountResourceId` |
| `object-storage` | `configuration.containers[]` | `storageBlobEndpoint`, `storageAccountName`, `storageAccountResourceId` |
| `configuration-store` | `configuration.values` | `appConfigurationEndpoint`, `appConfigurationName`, `appConfigurationResourceId` |
| `application-monitoring` | No required configuration | `applicationInsightsConnectionString`, `applicationInsightsName` |
| `container-host` | `source`, `containerPort`, `healthPath`, `authentication`, `configuration.runtimeSettings`, `configuration.ingress` | Component-oriented URL and identity outputs listed below |
| `bot-identity` | Usually owned by a frontend component | `botClientId`, `botIdentityPrincipalId`, `botIdentityResourceId`, `tenantId` |
| `teams-application` | Teams manifest source and configuration | `teamsAppId` |
| `authorized-api-connection` | `authorization: "interactive"` | `teamsConnectionResourceId`, `connectionResourceId` |
| `workflow-host` | ARM template `source`; `parameters.parameters` | An output ending in `IdentityPrincipalId` when the workflow has an identity |

Supported `container-host` outputs are:

- `agentEndpoint`, `agentIdentityClientId`, `agentIdentityPrincipalId`,
  `agentIdentityResourceId`;
- `backendBaseUrl`, `backendAudience`, `backendIdentityClientId`,
  `backendIdentityPrincipalId`, `backendIdentityResourceId`;
- `frontendBaseUrl`, `frontendIdentityClientId`,
  `frontendIdentityPrincipalId`, `frontendIdentityResourceId`.

Use the output family that matches the component's role. Do not invent a new
output name; use direct authoring when the contract vocabulary does not fit.

Supported `access[].role` values are:

- `AcrPull`;
- `App Configuration Data Reader`;
- `Azure AI User` or `Foundry User`;
- `Storage Blob Data Contributor`;
- `Cosmos DB Built-in Data Contributor`.

Each access grant's `principalOutput` must be produced by another declared
resource.

## Contract rules

- `schemaVersion` must be `1.0` in both files.
- Component IDs must be unique and match exactly between
  `enabledComponents` and `components`.
- Resource IDs must be unique.
- Every resource needs at least one valid `requiredBy` component.
- Every output name must have exactly one producer.
- Every `${output.<name>}` binding must have a producer.
- Output bindings establish component dependencies; dependency cycles are
  rejected.
- Resources required by one component are generated with that component.
  Multi-component resources are generated in the shared layer.
- A `model-deployment.parent` must identify an `ai-project`.
- Workflow resources need a readable ARM template and values for each consumed
  workflow parameter.
- Interactive API connections remain disabled until authorized. Do not bypass
  that consent checkpoint.
- Replace placeholders such as `<teams-group-id>` before enabling a workflow.

## Generate and inspect

Run the repository's local CLI:

```bash
iac-compose generate \
  --resources ./config/resource-requirements.json \
  --solution ./solution.json \
  --output ./deployment
```

Generation reports these stages in order:

1. `loadingInputs`
2. `validatingContracts`
3. `planningComponents`
4. `renderingSources`
5. `writingFiles`
6. `completed`

Inspect the reported component order. The output contains `deploy.ts`,
component-local lifecycle and provisioning files, runtime helpers, a package
manifest, and a TypeScript configuration. Regeneration owns only the files
listed in `.iac-compose-codegen.json`, but edits to those owned files can be
replaced; prefer changing contracts or separately owned source.

Install only the generated package's declared dependencies, then typecheck it:

```bash
npm install --prefix ./deployment
npm run --prefix ./deployment typecheck
```

Use the target repository's package manager instead of npm when its generated
package and scripts are configured for that manager.

## Validate and dry-run

Provider and deployment-principal validation queries Azure:

```bash
iac-compose validate \
  --resources ./config/resource-requirements.json \
  --resource-group <resource-group>
```

Use `--scope <azure-resource-id>` instead of `--resource-group` for an explicit
scope. Run without `--grant` first. `--grant` creates missing role assignments
and must be used only when the user requests that change.

Then compile all provisioning layers and inspect lifecycle order without Azure
or application side effects:

```bash
iac-compose ./deployment/deploy.ts --environment dev --dry-run
```

Run a single generated component when needed:

```bash
iac-compose ./deployment/deploy.ts --environment dev --component api --dry-run
```

Only remove a generated environment on explicit request:

```bash
iac-compose down ./deployment/.generated --environment dev --force
```

Do not add `--purge` without separate confirmation.
