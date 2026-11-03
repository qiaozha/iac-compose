import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  extractOfficialImplementationUrls,
  fetchAzureArchitectureCatalog,
  parseAzureArchitectureSource,
} from "../src/architecture-catalog.js";

const basicWebSource = `### YamlMime:Architecture
metadata:
  title: Basic Web Application
  description: A web application reference.
  ms.date: 10/10/2025
  ms.topic: reference-architecture
name: Basic web application
azureCategories:
  - web
summary: A web application reference.
products:
  - azure-app-service
  - azure-monitor
  - azure-sql-database
content: |
  [!INCLUDE[](basic-web-app-content.md)]
`;

test("parses architecture metadata and routes unsupported products directly", () => {
  const entry = parseAzureArchitectureSource(
    "docs/web-apps/architectures/basic-web-app.yml",
    basicWebSource,
    "commit-sha",
  );

  assert.ok(entry);
  assert.equal(entry.id, "web-apps/architectures/basic-web-app");
  assert.equal(
    entry.url,
    "https://learn.microsoft.com/en-us/azure/architecture/web-apps/architectures/basic-web-app",
  );
  assert.equal(
    entry.contentPath,
    "docs/web-apps/architectures/basic-web-app-content.md",
  );
  assert.equal(
    entry.contentSourceUrl,
    "https://github.com/MicrosoftDocs/architecture-center/blob/commit-sha/docs/web-apps/architectures/basic-web-app-content.md",
  );
  assert.deepEqual(entry.implementation, {
    mode: "hybrid",
    contractKinds: ["application-monitoring", "container-host"],
    directProducts: ["azure-sql-database"],
    requiresArchitectureReview: true,
  });
});

test("ignores non-architecture YAML documents", () => {
  assert.equal(
    parseAzureArchitectureSource(
      "docs/browse/index.yml",
      "### YamlMime:ContentBrowser\ntitle: Browse Azure Architectures\n",
      "commit-sha",
    ),
    undefined,
  );
});

test("normalizes index source files to their public Learn route", () => {
  const entry = parseAzureArchitectureSource(
    "docs/example-scenario/forensics/index.yml",
    basicWebSource,
    "commit-sha",
  );

  assert.equal(entry?.id, "example-scenario/forensics");
  assert.equal(
    entry?.url,
    "https://learn.microsoft.com/en-us/azure/architecture/example-scenario/forensics",
  );
});

test("extracts only implementation-oriented GitHub links from article content", () => {
  assert.deepEqual(
    extractOfficialImplementationUrls(`
An [example implementation](https://github.com/Azure-Samples/example) supports this guidance.
Read the [service documentation](https://github.com/MicrosoftDocs/docs).
Deploy the [reference sample](https://github.com/mspnp/reference/tree/main/infra).
The deployment pipeline uses [GitHub Actions](https://github.com/features/actions).
`),
    [
      "https://github.com/Azure-Samples/example",
      "https://github.com/mspnp/reference/tree/main/infra",
    ],
  );
});

test("extracts a pinned and complete catalog from GitHub source", async () => {
  const requested: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/commits/")) {
      return jsonResponse({ sha: "resolved-commit" });
    }
    if (url.includes("/git/trees/")) {
      return jsonResponse({
        truncated: false,
        tree: [
          { path: "docs/browse/index.yml", type: "blob" },
          { path: "docs/web-apps/architectures/basic-web-app.yml", type: "blob" },
          { path: "docs/readme.md", type: "blob" },
        ],
      });
    }
    if (url.endsWith("docs/browse/index.yml")) {
      return new Response(
        "### YamlMime:ContentBrowser\ntitle: Browse Azure Architectures\n",
      );
    }
    if (url.endsWith("docs/web-apps/architectures/basic-web-app.yml")) {
      return new Response(basicWebSource);
    }
    if (url.endsWith("docs/web-apps/architectures/basic-web-app-content.md")) {
      return new Response(
        "Use the [reference implementation](https://github.com/Azure-Samples/basic-web).",
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const catalog = await fetchAzureArchitectureCatalog({
    ref: "main",
    concurrency: 2,
    fetch: request,
  });

  assert.equal(catalog.source.commit, "resolved-commit");
  assert.equal(catalog.counts.architectures, 1);
  assert.deepEqual(catalog.counts.categories, { web: 1 });
  assert.deepEqual(catalog.counts.products, {
    "azure-app-service": 1,
    "azure-monitor": 1,
    "azure-sql-database": 1,
  });
  assert.equal(catalog.architectures.length, 1);
  assert.deepEqual(catalog.architectures[0]?.officialImplementationUrls, [
    "https://github.com/Azure-Samples/basic-web",
  ]);
  assert.ok(
    requested.some((url) =>
      url.includes("/git/trees/resolved-commit?recursive=1"),
    ),
  );
});

test("rejects a truncated GitHub tree", async () => {
  const request: typeof fetch = async (input) =>
    String(input).includes("/commits/")
      ? jsonResponse({ sha: "resolved-commit" })
      : jsonResponse({ truncated: true, tree: [] });

  await assert.rejects(
    fetchAzureArchitectureCatalog({ fetch: request }),
    /truncated.*incomplete architecture catalog/i,
  );
});

test("keeps the checked-in catalog complete, pinned, and uniquely ordered", async () => {
  const catalog = JSON.parse(
    await readFile(
      resolve(
        ".github/skills/azure-infrastructure-intent/references/architecture-catalog.json",
      ),
      "utf8",
    ),
  ) as {
    source: { commit: string };
    counts: { architectures: number };
    architectures: Array<{
      id: string;
      sourceUrl: string;
      implementation: { requiresArchitectureReview: boolean };
      officialImplementationUrls?: string[];
    }>;
  };
  const ids = catalog.architectures.map(({ id }) => id);

  assert.equal(catalog.counts.architectures, 194);
  assert.equal(catalog.architectures.length, catalog.counts.architectures);
  assert.match(catalog.source.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of catalog.architectures) {
    assert.ok(entry.sourceUrl.includes(catalog.source.commit));
    assert.equal(entry.implementation.requiresArchitectureReview, true);
    assert.ok(
      entry.officialImplementationUrls?.every((url) =>
        url.startsWith("https://github.com/"),
      ) ?? true,
    );
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
