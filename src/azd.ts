import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Deployment } from "./index.js";

export type AzdEnvironmentValues = Readonly<
  Record<string, string | undefined>
>;

export interface AzdProjectOptions {
  directory: string;
  manifest: Readonly<Record<string, unknown>>;
  mergeManifest?: boolean;
  environment?: string;
  subscription?: string;
  location?: string;
  values?: AzdEnvironmentValues;
}

export interface AzdDeployOptions {
  fromPackage?: string;
  timeout?: number;
}

export class AzdProject {
  readonly directory: string;
  readonly environment: string;

  readonly #deployment: Deployment;
  readonly #options: AzdProjectOptions;
  #initialized = false;

  constructor(deployment: Deployment, options: AzdProjectOptions) {
    this.#deployment = deployment;
    this.#options = options;
    this.directory = resolve(deployment.projectDirectory, options.directory);
    this.environment =
      options.environment ??
      deployment.environment ??
      process.env.AZURE_ENV_NAME ??
      "dev";
  }

  async provision(layer?: string): Promise<Record<string, string>> {
    await this.initialize();
    const args = ["provision"];
    if (layer) args.push(layer);
    args.push("--environment", this.environment, "--no-prompt");
    await this.#deployment.execute({
      command: "azd",
      args,
      cwd: this.directory,
    });
    if (this.#deployment.dryRun) return {};
    return this.getValues();
  }

  async deploy(
    service: string,
    options: AzdDeployOptions = {},
  ): Promise<Record<string, string>> {
    await this.initialize();
    const args = [
      "deploy",
      service,
      "--environment",
      this.environment,
      "--no-prompt",
    ];
    if (options.fromPackage) {
      args.push("--from-package", options.fromPackage);
    }
    if (options.timeout !== undefined) {
      args.push("--timeout", String(options.timeout));
    }
    await this.#deployment.execute({
      command: "azd",
      args,
      cwd: this.directory,
    });
    if (this.#deployment.dryRun) return {};
    return this.getValues();
  }

  async capture(args: readonly string[]): Promise<string> {
    await this.initialize();
    return this.#deployment.capture({
      command: "azd",
      args: [...args],
      cwd: this.directory,
    });
  }

  async getValues(): Promise<Record<string, string>> {
    if (!(await this.#environmentExists())) return {};
    const output = await this.#deployment.capture({
      command: "azd",
      args: ["env", "get-values", "--environment", this.environment],
      cwd: this.directory,
    });
    const values = parseAzdEnvironment(output);
    Object.assign(process.env, values);
    return values;
  }

  async setValues(values: AzdEnvironmentValues): Promise<void> {
    await this.initialize();
    const compacted = compactValues(values);
    await this.#writeValues(compacted);
    Object.assign(process.env, compacted);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;

    await mkdir(this.directory, { recursive: true });
    const manifest = this.#options.mergeManifest
      ? await mergeAzdManifest(
          resolve(this.directory, "azure.yaml"),
          this.#options.manifest,
        )
      : this.#options.manifest;
    await writeFile(
      resolve(this.directory, "azure.yaml"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );

    if (this.#deployment.dryRun) {
      this.#initialized = true;
      return;
    }

    if (!(await this.#environmentExists())) {
      const args = ["env", "new", this.environment, "--no-prompt"];
      const subscription =
        this.#options.subscription ?? process.env.AZURE_SUBSCRIPTION_ID;
      const location = this.#options.location ?? process.env.AZURE_LOCATION;
      if (subscription) args.push("--subscription", subscription);
      if (location) args.push("--location", location);
      await this.#deployment.execute({
        command: "azd",
        args,
        cwd: this.directory,
      });
    }

    const values = compactValues({
      AZURE_ENV_NAME: this.environment,
      AZURE_SUBSCRIPTION_ID:
        this.#options.subscription ?? process.env.AZURE_SUBSCRIPTION_ID,
      AZURE_LOCATION: this.#options.location ?? process.env.AZURE_LOCATION,
      AZURE_RESOURCE_GROUP: process.env.AZURE_RESOURCE_GROUP,
      ...this.#options.values,
    });
    await this.#writeValues(values);

    this.#initialized = true;
  }

  async #writeValues(values: Readonly<Record<string, string>>): Promise<void> {
    if (Object.keys(values).length === 0) return;
    const valuesFile = resolve(
      this.directory,
      `.deploy-js-env-${process.pid}-${Date.now()}`,
    );
    if (!this.#deployment.dryRun) {
      await writeFile(valuesFile, serializeAzdEnvironment(values), {
        mode: 0o600,
      });
    }
    try {
      await this.#deployment.execute({
        command: "azd",
        args: [
          "env",
          "set",
          "--file",
          valuesFile,
          "--environment",
          this.environment,
          "--no-prompt",
        ],
        cwd: this.directory,
      });
    } finally {
      if (!this.#deployment.dryRun) {
        await rm(valuesFile, { force: true });
      }
    }
  }

  async #environmentExists(): Promise<boolean> {
    if (this.#deployment.dryRun) return false;
    try {
      await access(
        resolve(this.directory, ".azure", this.environment, "config.json"),
      );
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }
}

export function createAzdProject(
  deployment: Deployment,
  options: AzdProjectOptions,
): AzdProject {
  return new AzdProject(deployment, options);
}

export function parseAzdEnvironment(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    values[key] = value;
  }
  return values;
}

function compactValues(
  values: AzdEnvironmentValues,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function serializeAzdEnvironment(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function mergeAzdManifest(
  path: string,
  manifest: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  let existing: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Generated azd manifest '${path}' must contain an object.`);
    }
    existing = value as Record<string, unknown>;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return manifest;
    throw error;
  }

  return {
    ...existing,
    ...manifest,
    ...(existing.name === undefined ? {} : { name: existing.name }),
    ...mergeManifestInfra(existing, manifest),
    ...mergeManifestSection("services", existing, manifest),
  };
}

function mergeManifestInfra(
  existing: Readonly<Record<string, unknown>>,
  manifest: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const existingValue = asRecord(existing.infra);
  const manifestValue = asRecord(manifest.infra);
  if (!existingValue && !manifestValue) return {};

  const infra = { ...existingValue, ...manifestValue };
  const existingLayers = asLayers(existingValue?.layers);
  const manifestLayers = asLayers(manifestValue?.layers);
  if (existingLayers || manifestLayers) {
    const layers = [...(existingLayers ?? [])];
    for (const layer of manifestLayers ?? []) {
      const index = layers.findIndex((candidate) => candidate.name === layer.name);
      if (index < 0) layers.push(layer);
      else layers[index] = layer;
    }
    delete infra.path;
    delete infra.module;
    infra.layers = layers;
  }
  return { infra };
}

function mergeManifestSection(
  name: "infra" | "services",
  existing: Readonly<Record<string, unknown>>,
  manifest: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const existingValue = asRecord(existing[name]);
  const manifestValue = asRecord(manifest[name]);
  if (!existingValue && !manifestValue) return {};
  return { [name]: { ...existingValue, ...manifestValue } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asLayers(
  value: unknown,
): (Readonly<Record<string, unknown>> & { readonly name: string })[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((layer) => {
    if (
      typeof layer !== "object" ||
      layer === null ||
      Array.isArray(layer) ||
      typeof (layer as Record<string, unknown>).name !== "string"
    ) {
      throw new Error("Generated azd manifest contains an invalid infrastructure layer.");
    }
    return layer as Readonly<Record<string, unknown>> & { readonly name: string };
  });
}