import assert from "node:assert/strict";
import { test } from "node:test";
import { IacComposerError, describeRuntimeCapabilities } from "iac-composer";
import {
  contextTopics,
  getAzureInfrastructureContext,
} from "../src/agent-context.js";

test("first-contact context is small, explicit about precedence, and does not dump references", async () => {
  const context = await getAzureInfrastructureContext();
  assert.equal(context.schemaVersion, "1.0");
  assert.equal(context.topic, "start");
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 8 * 1024);
  assert.match(JSON.stringify(context.data.routing), /existing compatible Terraform, Bicep, azd/);
  assert.match(JSON.stringify(context.data.routing), /Advice-only or plan-only/);
  assert.deepEqual(context.data.generationInputs, ["resourcesFile", "solutionFile", "outputDirectory"]);
  assert.equal(Object.hasOwn(context.data, "architectures"), false);
  assert.equal(Object.hasOwn(context.data, "contents"), false);
});

test("all advertised references and runtime metadata resolve without network access", async (t) => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Context must not access the network."); };
  t.after(() => { globalThis.fetch = fetch; });
  for (const topic of contextTopics) {
    const context = await getAzureInfrastructureContext(topic,
      topic === "architecture-catalog" ? { query: "web application", limit: 1 } : {},
    );
    assert.equal(context.topic, topic);
    assert.ok(Object.keys(context.data).length > 0);
  }
  const runtime = await getAzureInfrastructureContext("runtime-provisioning");
  assert.deepEqual(runtime.data.capabilities, describeRuntimeCapabilities("provisioning"));
  const resources = await getAzureInfrastructureContext("resources");
  assert.ok(Array.isArray(resources.data.kinds));
  assert.ok(resources.data.kinds.includes("object-storage"));
  const schema = await getAzureInfrastructureContext("schema");
  assert.ok(typeof schema.data.schema === "object" && schema.data.schema !== null);
});

test("catalog lookup is bounded, deterministic and provenance is decision support only", async () => {
  const first = await getAzureInfrastructureContext("architecture-catalog", { query: "app service", limit: 2 });
  assert.deepEqual(first, await getAzureInfrastructureContext("architecture-catalog", { query: "app service", limit: 2 }));
  assert.ok(Array.isArray(first.data.results));
  assert.ok(first.data.results.length > 0 && first.data.results.length <= 2);
  assert.match(String(first.data.constraint), /keep catalog provenance out/);
});

test("unknown topics, arbitrary resource paths and invalid catalog queries fail explicitly", async () => {
  for (const [topic, options, code] of [
    ["toString", {}, "CONTEXT_TOPIC_UNKNOWN"],
    ["../../package.json", {}, "CONTEXT_TOPIC_UNKNOWN"],
    ["start", { query: "ignored" }, "CONTEXT_ARGUMENT_INVALID"],
    ["architecture-catalog", {}, "CONTEXT_ARGUMENT_INVALID"],
    ["architecture-catalog", { query: "storage", limit: 11 }, "CONTEXT_ARGUMENT_INVALID"],
  ] as const) {
    await assert.rejects(getAzureInfrastructureContext(topic, options), (error: unknown) => {
      assert.ok(error instanceof IacComposerError);
      assert.equal(error.diagnostic.code, code);
      assert.ok(error.diagnostic.repair);
      return true;
    });
  }
});
