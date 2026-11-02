import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type {
  DeploymentSolution,
  ResourceRequirements,
} from "../src/generation/contracts/deployment.js";
import { loadServiceHelperSources } from "../src/generation/rendering/service-helpers.js";

for (const scenario of [
  { kinds: [], hostedAgent: false, expected: [] },
  { kinds: ["container-host"], hostedAgent: false, expected: [] },
  { kinds: ["teams-application"], hostedAgent: false, expected: ["teams"] },
  { kinds: [], hostedAgent: true, expected: ["hosted-agent", "values"] },
  { kinds: ["workflow-host"], hostedAgent: false, expected: ["values", "workflows"] },
  {
    kinds: ["workflow-host", "authorized-api-connection", "teams-application"],
    hostedAgent: true,
    expected: ["connections", "hosted-agent", "teams", "values", "workflows"],
  },
]) {
  test(`emits local helper source for ${scenario.kinds.join(", ") || "empty"} / hosted=${scenario.hostedAgent}`, async () => {
    const requirements: ResourceRequirements = {
      schemaVersion: "1.0",
      solution: { name: "helpers", enabledComponents: ["app"] },
      resources: scenario.kinds.map((kind, index) => ({
        id: `resource${index}`,
        kind,
        requiredBy: ["app"],
      })),
    };
    const solution: DeploymentSolution = {
      schemaVersion: "1.0",
      components: [{ id: "app", kind: scenario.hostedAgent ? "hosted-agent" : "http-api" }],
    };
    const sources = await loadServiceHelperSources(resolve("."), requirements, solution);
    assert.deepEqual(
      [...sources.keys()],
      scenario.expected.map((name) => `runtime/services/${name}.ts`),
    );
    for (const [path, source] of sources) {
      assert.equal(source, await readFile(resolve("src", path), "utf8"));
      assert.doesNotMatch(source, /azure-infrastructure|ResourceContract/);
    }
  });
}
