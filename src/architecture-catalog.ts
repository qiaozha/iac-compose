import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { parse } from "yaml";

const architectureRepository = "MicrosoftDocs/architecture-center";
const architectureRepositoryUrl =
  "https://github.com/MicrosoftDocs/architecture-center";
const architectureBrowseUrl =
  "https://learn.microsoft.com/en-us/azure/architecture/browse/";

const contractProductKinds: Readonly<Record<string, string>> = {
  "azure-app-configuration": "configuration-store",
  "azure-app-service": "container-host",
  "azure-blob-storage": "object-storage",
  "azure-bot-service": "bot-identity",
  "azure-container-registry": "container-registry",
  "azure-cosmos-db": "document-database",
  "azure-logic-apps": "workflow-host",
  "azure-monitor": "application-monitoring",
  "azure-storage": "object-storage",
  "foundry-agent-service": "ai-project",
  "microsoft-foundry": "ai-project",
};

export type ArchitectureImplementationMode = "contract" | "hybrid" | "direct";

export interface ArchitectureImplementationRoute {
  readonly mode: ArchitectureImplementationMode;
  readonly contractKinds: readonly string[];
  readonly directProducts: readonly string[];
  readonly requiresArchitectureReview: true;
}

export interface AzureArchitectureCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly sourcePath: string;
  readonly sourceUrl: string;
  readonly contentPath?: string;
  readonly contentSourceUrl?: string;
  readonly officialImplementationUrls?: readonly string[];
  readonly categories: readonly string[];
  readonly products: readonly string[];
  readonly topic?: string;
  readonly publishedDate?: string;
  readonly implementation: ArchitectureImplementationRoute;
}

export interface AzureArchitectureCatalog {
  readonly schemaVersion: "1.0";
  readonly source: {
    readonly browseUrl: string;
    readonly repository: string;
    readonly repositoryUrl: string;
    readonly ref: string;
    readonly commit: string;
    readonly documentationLicense: "CC-BY-4.0";
    readonly codeLicense: "MIT";
  };
  readonly counts: {
    readonly architectures: number;
    readonly categories: Readonly<Record<string, number>>;
    readonly products: Readonly<Record<string, number>>;
  };
  readonly architectures: readonly AzureArchitectureCatalogEntry[];
}

export interface FetchArchitectureCatalogOptions {
  readonly ref?: string;
  readonly token?: string;
  readonly concurrency?: number;
  readonly fetch?: typeof fetch;
}

interface GitHubCommitResponse {
  readonly sha?: unknown;
}

interface GitHubTreeItem {
  readonly path?: unknown;
  readonly type?: unknown;
}

interface GitHubTreeResponse {
  readonly truncated?: unknown;
  readonly tree?: unknown;
}

export async function fetchAzureArchitectureCatalog(
  options: FetchArchitectureCatalogOptions = {},
): Promise<AzureArchitectureCatalog> {
  const ref = options.ref ?? "main";
  const request = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "iac-compose-architecture-catalog",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const commitResponse = await fetchJson<GitHubCommitResponse>(
    request,
    `https://api.github.com/repos/${architectureRepository}/commits/${encodeURIComponent(ref)}`,
    headers,
  );
  const commit = requiredString(commitResponse.sha, "GitHub commit sha");
  const treeResponse = await fetchJson<GitHubTreeResponse>(
    request,
    `https://api.github.com/repos/${architectureRepository}/git/trees/${commit}?recursive=1`,
    headers,
  );
  if (treeResponse.truncated === true) {
    throw new Error(
      `The ${architectureRepository} Git tree is truncated; refusing to publish an incomplete architecture catalog.`,
    );
  }
  if (!Array.isArray(treeResponse.tree)) {
    throw new Error("GitHub tree response does not contain a tree array.");
  }
  const sourcePaths = treeResponse.tree
    .filter(isGitHubTreeItem)
    .filter(
      (item) =>
        item.type === "blob" &&
        item.path.startsWith("docs/") &&
        /\.ya?ml$/i.test(item.path),
    )
    .map((item) => item.path)
    .sort();

  const entries = (
    await mapConcurrent(
      sourcePaths,
      options.concurrency ?? 12,
      async (sourcePath) => {
        const response = await request(
          `https://raw.githubusercontent.com/${architectureRepository}/${commit}/${encodePath(sourcePath)}`,
          { headers: { "User-Agent": headers["User-Agent"] } },
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch architecture source '${sourcePath}': ${response.status} ${response.statusText}.`,
          );
        }
        const entry = parseAzureArchitectureSource(
          sourcePath,
          await response.text(),
          commit,
        );
        if (!entry?.contentPath) return entry;
        const contentResponse = await request(
          `https://raw.githubusercontent.com/${architectureRepository}/${commit}/${encodePath(entry.contentPath)}`,
          { headers: { "User-Agent": headers["User-Agent"] } },
        );
        if (!contentResponse.ok) {
          throw new Error(
            `Failed to fetch architecture content '${entry.contentPath}': ${contentResponse.status} ${contentResponse.statusText}.`,
          );
        }
        const officialImplementationUrls = extractOfficialImplementationUrls(
          await contentResponse.text(),
        );
        return {
          ...entry,
          ...(officialImplementationUrls.length > 0
            ? { officialImplementationUrls }
            : {}),
        };
      },
    )
  )
    .filter(
      (entry): entry is AzureArchitectureCatalogEntry => entry !== undefined,
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    schemaVersion: "1.0",
    source: {
      browseUrl: architectureBrowseUrl,
      repository: architectureRepository,
      repositoryUrl: architectureRepositoryUrl,
      ref,
      commit,
      documentationLicense: "CC-BY-4.0",
      codeLicense: "MIT",
    },
    counts: {
      architectures: entries.length,
      categories: countValues(entries.flatMap((entry) => entry.categories)),
      products: countValues(entries.flatMap((entry) => entry.products)),
    },
    architectures: entries,
  };
}

export function extractOfficialImplementationUrls(
  content: string,
): readonly string[] {
  const urls = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    for (const match of line.matchAll(
      /\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)/gi,
    )) {
      const label = match[1]!;
      const prefix = line.slice(Math.max(0, (match.index ?? 0) - 120), match.index);
      if (
        /(?:implementation|sample|source code|deploy(?:ment)?(?: template)?)/i.test(
          label,
        ) ||
        /(?:implementation|sample|source code)(?:.{0,100})$/i.test(prefix)
      ) {
        urls.add(match[2]!);
      }
    }
  }
  return [...urls].sort();
}

export function parseAzureArchitectureSource(
  sourcePath: string,
  source: string,
  commit: string,
): AzureArchitectureCatalogEntry | undefined {
  const mime = source.match(/^###\s+YamlMime:(\S+)\s*$/m)?.[1];
  if (mime !== "Architecture") return undefined;

  const document = asRecord(
    parse(source.replace(/^###\s+YamlMime:\S+\s*$/m, "")),
    sourcePath,
  );
  const metadata = asOptionalRecord(document.metadata);
  const relativePath = sourcePath
    .replace(/^docs\//, "")
    .replace(/\.ya?ml$/i, "");
  const architectureId = relativePath.replace(/\/index$/i, "");
  const products = stringArray(document.products);
  const contractKinds = [
    ...new Set(
      products
        .map((product) => contractProductKinds[product])
        .filter((kind): kind is string => kind !== undefined),
    ),
  ].sort();
  const directProducts = products.filter(
    (product) => contractProductKinds[product] === undefined,
  );
  const content = optionalString(document.content);
  const include = content?.match(/\[!INCLUDE\[\]\(([^)]+)\)\]/i)?.[1];
  const contentPath = include
    ? posix.normalize(posix.join(posix.dirname(sourcePath), include))
    : undefined;

  return {
    id: architectureId,
    name: requiredString(document.name, `${sourcePath} name`),
    title:
      optionalString(metadata?.title) ??
      requiredString(document.name, `${sourcePath} name`),
    summary:
      optionalString(document.summary) ??
      optionalString(metadata?.description) ??
      "",
    url: `${architectureBrowseUrl.replace(/browse\/$/, "")}${architectureId}`,
    sourcePath,
    sourceUrl: `https://github.com/${architectureRepository}/blob/${commit}/${sourcePath}`,
    ...(contentPath
      ? {
          contentPath,
          contentSourceUrl: `https://github.com/${architectureRepository}/blob/${commit}/${contentPath}`,
        }
      : {}),
    categories: stringArray(document.azureCategories).sort(),
    products: [...products].sort(),
    ...(optionalString(metadata?.["ms.topic"])
      ? { topic: optionalString(metadata?.["ms.topic"]) }
      : {}),
    ...(optionalString(metadata?.["ms.date"])
      ? { publishedDate: optionalString(metadata?.["ms.date"]) }
      : {}),
    implementation: {
      mode:
        directProducts.length === 0
          ? "contract"
          : contractKinds.length === 0
            ? "direct"
            : "hybrid",
      contractKinds,
      directProducts: [...directProducts].sort(),
      requiresArchitectureReview: true,
    },
  };
}

export async function writeAzureArchitectureCatalog(
  catalog: AzureArchitectureCatalog,
  outputFile: string,
): Promise<void> {
  const destination = resolve(outputFile);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(catalog, null, 2)}\n`);
}

async function fetchJson<T>(
  request: typeof fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<T> {
  const response = await request(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch '${url}': ${response.status} ${response.statusText}.`,
    );
  }
  return (await response.json()) as T;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Architecture catalog concurrency must be a positive integer.");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await action(values[index]!);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(values.length, 1)) },
      () => worker(),
    ),
  );
  return results;
}

function countValues(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function isGitHubTreeItem(value: unknown): value is { path: string; type: string } {
  if (typeof value !== "object" || value === null) return false;
  const item = value as GitHubTreeItem;
  return typeof item.path === "string" && typeof item.type === "string";
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Architecture source '${label}' must contain a YAML object.`);
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}
