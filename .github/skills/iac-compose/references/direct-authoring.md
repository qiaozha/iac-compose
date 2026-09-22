# Direct TypeScript authoring

Use this workflow for custom infrastructure, existing Azure provisioning
library code, or deployment programs that need precise lifecycle control.

## Recommended layout

```text
deployment/
  deploy.ts
  components/
    shared/
      index.ts
      provisioning.ts
    api/
      index.ts
      provisioning.ts
  environments/
    dev.json
  runtime/
    environment.ts
    paths.ts
  package.json
  tsconfig.json
```

Small deployments may use only `deployment.ts` and `infra.ts`. Introduce
components when ownership or lifecycle order benefits from the separation.

## Deployment API

| API | Purpose | Dry-run behavior |
| --- | --- | --- |
| `defineDeployment(program)` | Marks the default deployment program. | The program still runs so steps can be discovered. |
| `deployment.provision(name, options)` | Compiles provisioning output, prepares an isolated azd project, runs `azd provision`, and returns string outputs. | Compiles and writes local generated artifacts; azd execution is skipped. |
| `deployment.deploy(name, action)` | Runs an application, configuration, or post-provisioning side effect. | Logs the step and skips the action. |
| `deployment.run(name, command)` | Runs a named command step. | Logs the step and skips the command. |
| `deployment.env(name, values)` | Applies process environment values in sequence. | Logs the step and skips the mutation. |
| `deployment.execute(command)` | Runs a command inside an existing action. | Logs and skips the command. |
| `deployment.capture(command)` | Captures stdout for an existing action. | Logs and returns an empty string. |
| `deployment.inDirectory(path)` | Creates a child context with the same environment, component, dry-run state, and logger. | Unchanged. |

`Command` values use `{ command, args, cwd, env }` and are spawned without a
shell. Keep each argument separate; do not build shell command strings.

## Minimal deployment program

```ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineDeployment,
  ensureResourceGroup,
  requiredEnv,
  type ProvisioningLayer,
} from "iac-compose";

const deploymentRoot = dirname(fileURLToPath(import.meta.url));
const coreLayer: ProvisioningLayer = {
  entrypoint: resolve(deploymentRoot, "infra.ts"),
  outputDirectory: resolve(deploymentRoot, ".generated/core"),
};

export default defineDeployment(async (deployment) => {
  await deployment.deploy("ensure resource group", async () => {
    await ensureResourceGroup(deployment, {
      name: requiredEnv("AZURE_RESOURCE_GROUP"),
      subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
      location: requiredEnv("AZURE_LOCATION"),
    });
  });

  const outputs = await deployment.provision("core infrastructure", {
    layer: coreLayer,
    deploymentName: `${deployment.environment ?? "dev"}-core`,
    scope: "resourceGroup",
    resourceGroup: requiredEnv("AZURE_RESOURCE_GROUP"),
    subscription: requiredEnv("AZURE_SUBSCRIPTION_ID"),
    location: requiredEnv("AZURE_LOCATION"),
  });

  await deployment.env("publish infrastructure outputs", outputs);
});
```

Use `deployment.env` for values needed later in the same run. Use the
repository's azd environment helper when outputs must survive future runs.

## Minimal provisioning entrypoint

Provisioning entrypoints are regular TypeScript or JavaScript modules. They
must export a non-empty `outputBicep` array. The following shape uses the Azure
JavaScript provisioning libraries:

```ts
import {
  createBicepParameterFile,
  renderBicepFiles,
  renderBicepParameterFile,
} from "@azure/provisioning-bicep";
import { fn, Stack } from "@azure/provisioning-core";
import { serialize } from "@azure/provisioning-serialization";
import { StorageAccount } from "@azure/provisioning-storage";

const stack = new Stack("main", { targetScope: "resourceGroup" });
const location = stack.parameters.add("location", "string");
const suffix = stack.variables.add(
  "suffix",
  fn.substring(fn.uniqueString(fn.resourceGroup().id), 0, 6),
);

const storage = new StorageAccount(stack, {
  name: fn.concat("appstorage", suffix),
  location,
  kind: "StorageV2",
  sku: { name: "Standard_LRS" },
  properties: {
    minimumTlsVersion: "TLS1_2",
    allowBlobPublicAccess: false,
    allowSharedKeyAccess: false,
    supportsHttpsTrafficOnly: true,
  } as any,
});

stack.outputs.add("STORAGE_ACCOUNT_NAME", "string", storage.name);

export const outputJson = serialize([stack]);
const [renderedStack] = renderBicepFiles(outputJson);
if (renderedStack === undefined) {
  throw new Error("Provisioning produced no Bicep entry file.");
}

const parameterFile = createBicepParameterFile("main.bicepparam", {
  using: "./main.bicep",
  parameters: {
    location: fn.readEnvironmentVariable("AZURE_LOCATION", "westus2"),
  },
});

export const outputBicep = [
  { ...renderedStack, path: "main.bicep" },
  renderBicepParameterFile(parameterFile),
];
```

Use the provisioning packages and versions already selected by the target
repository. Add only the resource-specific packages that the entrypoint imports.
If a provisioning SDK type is temporarily incomplete, keep any type escape as
narrow as possible around that SDK object.

## Provision options

`deployment.provision` accepts:

- `layer`: an `entrypoint` and `outputDirectory` pair;
- `entrypoint`: a TypeScript or JavaScript module exporting `outputBicep`;
- `compiler` plus `artifactsDirectory`: a custom command and its generated
  Bicep artifact directory;
- `outputDirectory`: standalone output or a `.generated/<layer>` directory;
- `templateFile` and `parametersFile`: overrides for `main.bicep` and
  `main.bicepparam`;
- `deploymentName`, `subscription`, and `location`;
- `scope`: `resourceGroup` or `subscription`;
- `resourceGroup` for resource-group deployments;
- `parameters`: string, number, or boolean Bicep parameter values;
- `environmentValues`: additional azd environment values.

Do not combine `layer` with `entrypoint`, `outputDirectory`, `compiler`, or
`artifactsDirectory`. For a custom compiler, provide both `compiler` and
`artifactsDirectory`.

## Layering and component selection

Putting output directly under one shared `.generated` root creates azd
infrastructure layers. The first appearance of each layer establishes its
dependency on the preceding layer, so call provisioning steps in business
order.

For selectable components:

```ts
import { defineDeployment, type Deployment } from "iac-compose";

const components: Record<
  string,
  (deployment: Deployment) => Promise<void>
> = {
  shared,
  api,
  frontend,
};

export default defineDeployment(async (deployment) => {
  await prepareEnvironment(deployment);
  if (deployment.component) {
    const run = Object.hasOwn(components, deployment.component)
      ? components[deployment.component]
      : undefined;
    if (!run) {
      throw new Error(
        `Unknown component '${deployment.component}'. Expected one of: ${Object.keys(components).join(", ")}.`,
      );
    }
    await run(deployment);
    return;
  }
  await shared(deployment);
  await api(deployment);
  await frontend(deployment);
});
```

## Commands

Prefer an existing package script. Equivalent local CLI commands are:

```bash
iac-compose ./deployment.ts --environment dev --dry-run
iac-compose ./deployment.ts --environment dev
iac-compose ./deployment.ts --environment dev --component api
```

For generated layered projects, cleanup is intentionally guarded:

```bash
iac-compose down ./.generated --environment dev --force
```

Only add `--purge` after the user explicitly confirms permanent deletion.
