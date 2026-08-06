# imperative-deploy

`deploy-js` runs TypeScript or JavaScript deployment programs in authored order.
Customer deployment programs do not need an azd project or azd hooks.

The runtime generates isolated, hook-free azd projects as an implementation
detail. It compiles JavaScript provisioning output into Bicep, delegates resource
deployment to `azd provision`, and exposes `AzdProject` for `azd deploy` service
targets while JavaScript retains lifecycle ordering.

```ts
import { defineDeployment } from "imperative-deploy";

export default defineDeployment(async (deployment) => {
  const outputs = await deployment.provision("infrastructure", {
    entrypoint: "./infra.ts",
    location: "westus2",
  });

  await deployment.deploy("API", async () => {
    await deployment.execute({
      command: "az",
      args: ["webapp", "deploy", "--name", outputs.API_NAME],
    });
  });
});
```

## Commands

```bash
npm install
npm run build
npm run deploy-js -- run ./deployment.ts --environment dev
npm run deploy-js -- run ./deployment.ts --environment dev --dry-run
```

`--dry-run` renders provisioning entrypoints and writes their generated Bicep,
parameter files, and `azure.yaml` manifests. It does not initialize azd
environments, run cloud commands, or execute application deployment callbacks.
Each component uses one `.generated/<component>/` azd project; its `azure.yaml`
contains both the Bicep `infra` configuration and any deployable `services`.

`-C <directory>` changes the deployment working directory. A program can use
`deployment.inDirectory(...)` for a scoped child context.

## Provisioning libraries

A provisioning entrypoint can export a non-empty `outputBicep` array of
`{ path, contents }` objects. Workspace libraries that require their own loader
can instead provide a compiler command and its artifact directory:

```ts
await deployment.provision("resources", {
  compiler: { command: "pnpm", args: ["run", "compile"] },
  artifactsDirectory: "generated/bicep",
  outputDirectory: ".generated/infra",
  location: process.env.AZURE_LOCATION,
});
```

The runtime records generated paths in `.deploy-js-generated.json` and only
replaces those files. Provisioning generates a JSON-compatible `azure.yaml`,
synchronizes an isolated azd environment, runs `azd provision`, and returns azd
environment outputs as strings.

## Chatbot integration

The chatbot is its own npm package. Its provisioning dependencies are packed
tarballs under `examples/chatbot/vendor/` and installed through
`examples/chatbot/package.json`; chatbot source never imports the neighboring
provisioning workspace or its `dist` directories. Refresh the tarballs from any
local provisioning workspace with:

```bash
npm --prefix examples/chatbot run install:local-provisioning -- /path/to/provisioning-workspace
npm ci --prefix examples/chatbot
```

The chatbot consumes this tool through the relative
`imperative-deploy: file:../..` package dependency and imports only the package
export, never the root `src` directory.

[examples/chatbot/src/deploy.ts](examples/chatbot/src/deploy.ts) is the centralized
business-order program:

```ts
await shared(deployment);
await agent(deployment);
await agentServer(deployment);
await functionApp(deployment);
await frontend(deployment);
await logicApp(deployment);
await knowledgeSync(deployment);
```

All implementation is grouped under
[examples/chatbot/src](examples/chatbot/src):

- `components/shared/` owns only the resource group, shared storage, identity,
  registry, configuration, Search, Cosmos DB, Key Vault, and Graph application.
- `components/agent/`, `components/frontend/`, `components/agent-server/`, and
  `components/function-app/` each own a colocated provisioning stack and run it
  immediately before that component's configuration and deployment.
- `components/agent/` owns the bot managed identity and deploys the hosted
  Foundry agent through a generated `azure.ai.agent` service, reading status
  through `azd ai agent show`.
- Application containers are built, published, and deployed by source-backed
  `azd deploy <service>` targets; component code supplies its source, Docker
  configuration, target resource, and settings.
- `components/logic-app/` waits for the Function host and then provisions its integration
  account, connections, complete workflow, identities, and alert from the typed
  TypeScript stack colocated in `provisioning.ts`. There is no workflow JSON or
  management API patch. Its Teams tenant, group, and channel IDs are selected
  from the component-local `config/<environment>.json` profile. Refresh the
  `dev`, `preview`, and `prod` profiles from the sibling `sdk-ai-bots`
  environment suite with:

  ```bash
  npm --prefix examples/chatbot run sync:logic-app-config
  ```
- `components/knowledge-sync/` owns Search bootstrap through the official Azure
  SDK and runs the application-owned synchronization process.
- `runtime/` contains only chatbot-specific environment composition and paths.
  Azure CLI execution, retries, readiness checks, azd App Service and Function
  deployment, RBAC, resource-group creation, account lookup, and environment-file
  primitives are exported by `imperative-deploy` itself.

The standalone environment state is stored in ignored
`examples/chatbot/.state/<environment>.json`. Non-secret environment inputs live
in `examples/chatbot/src/environments/<environment>.json`.

Prerequisites for a real deployment are Node.js 20+, `azd` 1.30.0+, `az`, `pnpm`,
`npm`, authenticated azd and Azure CLI sessions, and Microsoft 365 access for
Teams app registration. The deploying identity also needs Microsoft Graph application and
app-role-assignment permissions for the Graph Bicep resources. Tenants that
enforce Service Tree ownership for app registrations also require
`SERVICE_MANAGEMENT_REFERENCE`; keep that non-secret service ID in the
environment JSON.

Knowledge synchronization additionally requires:

- `AZURE_SDK_DOCS_PATH` and `AZURE_SDK_WIKI_PATH` pointing to the two internal
  repository checkouts;
- `AZURE_SDK_GITHUB_PAT` in the shell for token-authenticated GitHub sources;
- a base64-encoded `SSH-PRIVATE-KEY` secret in the provisioned Key Vault.

On a new environment, the first run provisions the Teams API connection and
then stops with its Azure portal consent URL. The same component provisioning
program runs with the workflow condition disabled for this bootstrap. Authorize
the connection and rerun; the next component provision includes the complete
workflow, and completed lifecycle functions are idempotent.

```bash
npm run deploy-js -- run examples/chatbot/src/deploy.ts -e dev --dry-run
npm run deploy-js -- run examples/chatbot/src/deploy.ts -e dev
```