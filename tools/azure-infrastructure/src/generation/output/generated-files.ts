import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { workspaceError, type GenerationWorkspace } from "../workspace.js";

const generatedManifest = ".iac-composer-codegen.json";
const previousGeneratedManifest = ".iac-compose-codegen.json";
const legacyGeneratedManifest = ".deploy-js-codegen.json";

export async function installGeneratedFiles(
  outputDirectory: string,
  files: ReadonlyMap<string, string>,
  options: { workspace?: GenerationWorkspace } = {},
): Promise<void> {
  if (options.workspace) {
    outputDirectory = await options.workspace.resolveWrite(outputDirectory);
    for (const name of [legacyGeneratedManifest, generatedManifest, previousGeneratedManifest]) {
      await options.workspace.resolveWrite(resolve(outputDirectory, name));
    }
  }
  await rejectLegacyGeneratedManifest(
    resolve(outputDirectory, legacyGeneratedManifest),
  );
  const manifestPath = resolve(outputDirectory, generatedManifest);
  const previousManifestPath = resolve(outputDirectory, previousGeneratedManifest);
  const ownedPaths = new Set([
    ...(await readGeneratedManifest(previousManifestPath, options.workspace !== undefined)),
    ...(await readGeneratedManifest(manifestPath, options.workspace !== undefined)),
  ]);
  if (options.workspace) {
    await preflightOwnedOutput(outputDirectory, files, ownedPaths, options.workspace);
  }
  await mkdir(outputDirectory, { recursive: true });
  for (const path of ownedPaths) {
    await rm(resolveGeneratedPath(outputDirectory, path), { force: true });
  }
  for (const [path, contents] of files) {
    const outputPath = resolveGeneratedPath(outputDirectory, path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents);
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 1, files: [...files.keys()].sort() }, null, 2)}\n`,
  );
  await rm(previousManifestPath, { force: true });
}

async function preflightOwnedOutput(
  outputDirectory: string,
  files: ReadonlyMap<string, string>,
  ownedPaths: ReadonlySet<string>,
  workspace: GenerationWorkspace,
): Promise<void> {
  const owned = new Set<string>();
  const generated = new Set<string>();
  for (const [paths, destination] of [[ownedPaths, owned], [files.keys(), generated]] as const) {
    for (const path of paths) {
      if (!path.trim() || isAbsolute(path) || [
        generatedManifest, previousGeneratedManifest, legacyGeneratedManifest,
      ].includes(path)) {
        throw workspaceError(
          "GENERATED_PATH_INVALID",
          "Generated paths and ownership records must name relative source files.",
          path,
          "Repair the source IDs or ownership manifest; do not include reserved metadata files.",
        );
      }
      const absolute = resolveGeneratedPath(outputDirectory, path);
      if (absolute === resolve(outputDirectory) || destination.has(absolute) ||
          [generatedManifest, previousGeneratedManifest, legacyGeneratedManifest]
            .some((name) => absolute === resolve(outputDirectory, name))) {
        throw workspaceError(
          "GENERATED_PATH_INVALID",
          "Generated paths must be unique files after normalization.",
          path,
          "Correct duplicate or directory-shaped paths before regenerating.",
        );
      }
      await workspace.resolveWrite(absolute);
      destination.add(absolute);
    }
  }
  for (const path of [...owned, ...generated]) {
    let existing;
    try {
      existing = await lstat(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (!existing.isFile() || existing.nlink > 1 || (generated.has(path) && !owned.has(path))) {
      throw workspaceError(
        "OUTPUT_CONFLICT",
        "Generation would replace a directory, a hard-linked file, or a customer-owned file.",
        path,
        "Choose a fresh output directory or review and back up existing files. Do not forge generator ownership metadata.",
      );
    }
  }
  for (const path of generated) {
    for (let parent = dirname(path); parent !== resolve(outputDirectory); parent = dirname(parent)) {
      if (generated.has(parent)) {
        throw workspaceError(
          "OUTPUT_CONFLICT",
          "Generated paths contain a file/directory conflict.",
          path,
          "Correct the conflicting source IDs before regenerating.",
        );
      }
    }
  }
}

async function rejectLegacyGeneratedManifest(path: string): Promise<void> {
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `Legacy deploy-js generated output detected at '${path}'. ` +
      "Remove the generated output directory and rerun azure-infrastructure.",
  );
}

async function readGeneratedManifest(path: string, strict = false): Promise<readonly string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("files" in value) ||
      !Array.isArray(value.files) ||
      !value.files.every((item) => typeof item === "string")
    ) {
      throw new Error(`Invalid generated deployment manifest '${path}'.`);
    }
    if (strict && (!("version" in value) || value.version !== 1)) {
      throw workspaceError(
        "OWNERSHIP_MANIFEST_INVALID",
        "The generated-file ownership manifest has an unsupported version.",
        path,
        "Use a fresh output directory or restore the original version-1 generator manifest.",
      );
    }
    return value.files;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function resolveGeneratedPath(outputDirectory: string, path: string): string {
  const outputPath = resolve(outputDirectory, path);
  const relativePath = relative(outputDirectory, outputPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Generated deployment path escapes its directory: ${path}`);
  }
  return outputPath;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}