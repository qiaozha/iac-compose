import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const generatedManifest = ".iac-compose-codegen.json";
const legacyGeneratedManifest = ".deploy-js-codegen.json";

export async function installGeneratedFiles(
  outputDirectory: string,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await rejectLegacyGeneratedManifest(
    resolve(outputDirectory, legacyGeneratedManifest),
  );
  const manifestPath = resolve(outputDirectory, generatedManifest);
  for (const path of await readGeneratedManifest(manifestPath)) {
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
      "Remove the generated output directory and rerun iac-compose.",
  );
}

async function readGeneratedManifest(path: string): Promise<readonly string[]> {
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