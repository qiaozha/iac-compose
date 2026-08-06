import { access, readdir, rm, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDirectories = [
  "bicep",
  "core",
  "serialization",
  "serialization-ast",
  "services/appconfiguration",
  "services/applicationinsights",
  "services/appservice",
  "services/authorization",
  "services/botservice",
  "services/cognitiveservices",
  "services/container-registry",
  "services/cosmosdb",
  "services/keyvault",
  "services/logic",
  "services/managedidentity",
  "services/monitor",
  "services/operationalinsights",
  "services/search",
  "services/storage",
];

const workspaceArgument = process.argv[2];
if (!workspaceArgument) {
  throw new Error(
    "Usage: npm run install:local-provisioning -- <provisioning-workspace>",
  );
}

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(workspaceArgument);
const vendorRoot = resolve(exampleRoot, "vendor");
for (const packageDirectory of packageDirectories) {
  await access(join(workspaceRoot, "packages", packageDirectory, "package.json"));
}
await mkdir(vendorRoot, { recursive: true });
for (const entry of await readdir(vendorRoot)) {
  if (/^azure-provisioning-.+\.tgz$/.test(entry)) {
    await rm(resolve(vendorRoot, entry));
  }
}

for (const packageDirectory of packageDirectories) {
  run("pnpm", [
    "--dir",
    join(workspaceRoot, "packages", packageDirectory),
    "pack",
    "--pack-destination",
    vendorRoot,
  ]);
}
run("npm", ["install"], exampleRoot);

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? "unknown"}.`);
  }
}