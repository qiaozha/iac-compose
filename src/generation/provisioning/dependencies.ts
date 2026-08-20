import { relative as pathRelative } from "node:path";

export function provisioningDependencies(
  outputDirectory: string,
  repositoryRoot: string,
): Readonly<Record<string, string>> {
  const version = "0.1.0";
  const vendorPath = pathRelative(
    outputDirectory,
    `${repositoryRoot}/vendor`,
  ).replaceAll("\\", "/");
  const vendorRoot = vendorPath.startsWith(".")
    ? vendorPath
    : `./${vendorPath}`;
  const packages = [
    "appconfiguration",
    "applicationinsights",
    "appservice",
    "authorization",
    "bicep",
    "botservice",
    "cognitiveservices",
    "container-registry",
    "core",
    "cosmosdb",
    "logic",
    "managed-identity",
    "operationalinsights",
    "serialization",
    "serialization-ast",
    "storage",
  ];
  return Object.fromEntries(
    packages.map((name) => [
      `@azure/provisioning-${name}`,
      `file:${vendorRoot}/azure-provisioning-${name}-${version}.tgz`,
    ]),
  );
}