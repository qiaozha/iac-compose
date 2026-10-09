import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const schemaPath = resolve(
  ".github/skills/azure-infrastructure-intent/references/implementation-contract.schema.json",
);
const fixturePath = resolve(
  "evals/iac-compose/fixtures/inferred-basic-web/implementation-contract.json",
);
const documentationPath = resolve("docs/implementation-contract.md");
const examplePaths = [
  resolve("docs/examples/implementation-contract.contract.json"),
  resolve("docs/examples/implementation-contract.direct.json"),
  fixturePath,
] as const;

test("defines a complete customer-facing implementation contract schema", async () => {
  const source = await readFile(schemaPath, "utf8");
  const schema = JSON.parse(source) as {
    description?: string;
    required: string[];
    properties: Record<string, { description?: string }>;
    $defs: {
      component: {
        properties: Record<string, { description?: string }>;
      };
      resource: {
        properties: Record<string, { description?: string }> & {
          implementation: {
            description?: string;
            oneOf: Array<{
              properties: {
                kind?: { enum?: string[] };
              };
            }>;
          };
        };
      };
      parameter: {
        properties: Record<string, { description?: string }>;
      };
      dependency: {
        properties: Record<string, { description?: string }>;
      };
      assumption: {
        properties: Record<string, { description?: string }>;
      };
    };
  };
  const expected = [
    "schemaVersion",
    "solution",
    "profile",
    "authoringMode",
    "components",
    "resources",
    "parameters",
    "dependencies",
    "deploymentOrder",
    "assumptions",
    "wellArchitected",
    "tradeoffs",
    "validation",
    "unresolved",
  ];

  assert.ok(schema.description);
  assert.deepEqual(schema.required, expected);
  assert.deepEqual(Object.keys(schema.properties), expected);
  for (const [field, property] of Object.entries(schema.properties)) {
    assert.ok(property.description, `Schema property '${field}' needs a description`);
  }
  for (const definition of [
    schema.$defs.component,
    schema.$defs.resource,
    schema.$defs.parameter,
    schema.$defs.dependency,
    schema.$defs.assumption,
  ]) {
    for (const [field, property] of Object.entries(definition.properties)) {
      assert.ok(
        property.description,
        `Schema definition property '${field}' needs a description`,
      );
    }
  }
  const supportedKinds =
    schema.$defs.resource.properties.implementation.oneOf[0]?.properties.kind
      ?.enum ?? [];
  assert.ok(supportedKinds.includes("container-host"));
  assert.ok(supportedKinds.includes("model-deployment"));
  assert.ok(supportedKinds.includes("container-registry"));
  assert.doesNotMatch(
    source,
    /referenceArchitecture|architectureCenter|sourceCommit|officialImplementationUrls/,
  );
});

test("keeps the inferred implementation fixture actionable and provenance-free", async () => {
  for (const path of examplePaths) {
    const source = await readFile(path, "utf8");
    validateExampleContract(source, path);
  }
});

test("documents every required contract field and both authoring routes", async () => {
  const [schemaSource, documentation] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(documentationPath, "utf8"),
  ]);
  const schema = JSON.parse(schemaSource) as { required: string[] };

  for (const field of schema.required) {
    assert.match(documentation, new RegExp(`\\\`${field}\\\``));
  }
  for (const heading of [
    "## Components",
    "## Resources",
    "## Parameters",
    "## Dependency graph and deployment order",
    "## Structural versus semantic validation",
    "## Privacy and secret handling",
    "## Versioning",
  ]) {
    assert.ok(documentation.includes(heading), `Missing documentation: ${heading}`);
  }
  assert.match(documentation, /implementation-contract\.contract\.json/);
  assert.match(documentation, /implementation-contract\.direct\.json/);
});

function validateExampleContract(source: string, path: string): void {
  const contract = JSON.parse(source) as {
    schemaVersion: string;
    authoringMode: string;
    components: Array<{ id: string }>;
    resources: Array<{
      id: string;
      requiredBy: string[];
      implementation: {
        mode: string;
        azureResourceTypes?: string[];
      };
      ownership: "shared" | "component";
      produces: string[];
      consumes: string[];
      access: Array<{ principalOutput?: string }>;
    }>;
    parameters: Array<{ name: string }>;
    dependencies: Array<{
      producer: string;
      consumer: string;
      via: string;
    }>;
    deploymentOrder: string[];
    unresolved: unknown[];
  };

  assert.equal(contract.schemaVersion, "1.0", path);
  assert.ok(
    ["contract", "direct", "hybrid"].includes(contract.authoringMode),
    path,
  );
  assert.equal(contract.unresolved.length, 0, path);
  assert.equal(
    new Set(contract.components.map(({ id }) => id)).size,
    contract.components.length,
    path,
  );
  assert.equal(
    new Set(contract.resources.map(({ id }) => id)).size,
    contract.resources.length,
    path,
  );
  const componentIds = new Set(contract.components.map(({ id }) => id));
  const resources = new Map(
    contract.resources.map((resource) => [resource.id, resource]),
  );
  const outputs = new Set(contract.resources.flatMap(({ produces }) => produces));
  assert.equal(
    outputs.size,
    contract.resources.reduce(
      (count, resource) => count + resource.produces.length,
      0,
    ),
    `${path}: output names must be unique`,
  );
  assert.equal(
    new Set(contract.parameters.map(({ name }) => name)).size,
    contract.parameters.length,
    `${path}: parameter names must be unique`,
  );
  const validLayers = new Set(componentIds);
  if (contract.resources.some(({ ownership }) => ownership === "shared")) {
    validLayers.add("shared");
  }
  assert.equal(
    new Set(contract.deploymentOrder).size,
    contract.deploymentOrder.length,
    `${path}: deployment order entries must be unique`,
  );
  assert.ok(
    contract.deploymentOrder.every((layer) => validLayers.has(layer)),
    `${path}: deployment order must use components or the shared layer`,
  );
  for (const resource of contract.resources) {
    assert.ok(resource.requiredBy.every((id) => componentIds.has(id)), path);
    if (resource.implementation.mode === "direct") {
      assert.ok(
        resource.implementation.azureResourceTypes?.every((type) =>
          /^[A-Za-z][A-Za-z0-9.]+\/.+/.test(type),
        ),
        path,
      );
    }
    assert.ok(
      resource.consumes.every((output) => outputs.has(output)),
      path,
    );
    assert.ok(
      resource.access.every(
        ({ principalOutput }) =>
          principalOutput === undefined || outputs.has(principalOutput),
      ),
      `${path}: access principals must be produced outputs`,
    );
  }
  for (const dependency of contract.dependencies) {
    assert.ok(resources.has(dependency.producer), path);
    assert.ok(resources.has(dependency.consumer), path);
    assert.ok(
      resources.get(dependency.producer)?.produces.includes(dependency.via),
      path,
    );
    assert.ok(
      resources.get(dependency.consumer)?.consumes.includes(dependency.via),
      path,
    );
    const producer = resources.get(dependency.producer)!;
    const consumer = resources.get(dependency.consumer)!;
    const producerLayer =
      producer.ownership === "shared" ? "shared" : producer.requiredBy[0]!;
    const consumerLayer =
      consumer.ownership === "shared" ? "shared" : consumer.requiredBy[0]!;
    assert.ok(
      contract.deploymentOrder.indexOf(producerLayer) <=
        contract.deploymentOrder.indexOf(consumerLayer),
      `${path}: producer ${producerLayer} must not follow ${consumerLayer}`,
    );
  }
  assertAcyclic(contract.resources.map(({ id }) => id), contract.dependencies, path);
  for (const resource of contract.resources) {
    for (const consumed of resource.consumes) {
      assert.equal(
        contract.dependencies.filter(
          ({ consumer, via }) => consumer === resource.id && via === consumed,
        ).length,
        1,
        `${path}: ${resource.id} must have one dependency for ${consumed}`,
      );
    }
  }
  assert.doesNotMatch(
    source,
    /Architecture Center|reference architecture|referenceArchitecture|architectureCenter|sourceCommit|officialImplementationUrls|MicrosoftDocs|Azure-Samples/i,
    path,
  );
}

function assertAcyclic(
  resourceIds: string[],
  dependencies: Array<{ producer: string; consumer: string }>,
  path: string,
): void {
  const indegree = new Map(resourceIds.map((id) => [id, 0]));
  const consumers = new Map(resourceIds.map((id) => [id, [] as string[]]));
  for (const { producer, consumer } of dependencies) {
    indegree.set(consumer, (indegree.get(consumer) ?? 0) + 1);
    consumers.get(producer)?.push(consumer);
  }
  const ready = resourceIds.filter((id) => indegree.get(id) === 0);
  let visited = 0;
  while (ready.length > 0) {
    const producer = ready.pop()!;
    visited += 1;
    for (const consumer of consumers.get(producer) ?? []) {
      const remaining = (indegree.get(consumer) ?? 0) - 1;
      indegree.set(consumer, remaining);
      if (remaining === 0) ready.push(consumer);
    }
  }
  assert.equal(
    visited,
    resourceIds.length,
    `${path}: dependencies must be acyclic`,
  );
}
