import { createRequire } from "node:module";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IacComposerError } from "./diagnostics.js";
import { containsPath, createWorkspacePaths } from "./workspace.js";

export const referencePackagePattern = /^(?:iac-composer|@azure\/provisioning-[a-z0-9-]+)$/;
const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const maxFiles = 256;
const maxFileBytes = 2 * 1024 * 1024;
const maxTotalBytes = 8 * 1024 * 1024;

export interface TypeScriptReference {
  packageName: string;
  version: string;
  entrypoint: string;
  declarationFiles: string[];
  matches: { file: string; line: number; endLine: number; excerpt: string }[];
  truncated: boolean;
  format: "TypeScript declarations";
}

export function referenceError(code: string, target: string, repair: string): IacComposerError {
  return new IacComposerError({
    code,
    category: "configuration",
    message: `TypeScript reference lookup failed for '${target}'.`,
    target,
    repair,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function manifest(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isObject(parsed)) {
    throw referenceError("PACKAGE_METADATA_INVALID", path, "Use a valid package.json object.");
  }
  return parsed;
}

async function projectPath(workspaceRoot: string, projectDirectory: string): Promise<string> {
  const workspace = await createWorkspacePaths(workspaceRoot);
  const project = await workspace.resolveRead(projectDirectory);
  if (!(await stat(project)).isDirectory()) {
    throw referenceError("PROJECT_DIRECTORY_INVALID", projectDirectory, "Select a directory inside the registered workspace.");
  }
  return project;
}

async function installedPackage(packageName: string, project: string) {
  if (!referencePackagePattern.test(packageName)) {
    throw referenceError("REFERENCE_PACKAGE_UNSUPPORTED", packageName, "Select iac-composer or an @azure/provisioning-* library, not a management SDK or arbitrary path.");
  }
  let root = runtimeRoot;
  if (packageName !== "iac-composer") {
    let entry: string;
    try {
      entry = createRequire(resolve(project, "package.json")).resolve(packageName);
    } catch (cause) {
      throw new IacComposerError({
        code: "SDK_PACKAGE_UNAVAILABLE",
        category: "configuration",
        message: `Provisioning library '${packageName}' is not installed for this project.`,
        target: packageName,
        repair: "Add the required library to the project's dependency manifest at the selected version and install dependencies. Lookup never downloads packages or substitutes a management SDK.",
      }, { cause });
    }
    root = dirname(entry);
    while (true) {
      try {
        const metadata = await manifest(resolve(root, "package.json"));
        if (metadata.name === packageName) break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const parent = dirname(root);
      if (parent === root) {
        throw referenceError("PACKAGE_METADATA_INVALID", packageName, "Install a provisioning package with matching package metadata.");
      }
      root = parent;
    }
  }
  root = await realpath(root);
  const metadata = await manifest(resolve(root, "package.json"));
  const types = typeof metadata.types === "string" ? metadata.types
    : typeof metadata.typings === "string" ? metadata.typings
    : exportedTypes(isObject(metadata.exports) ? metadata.exports["."] : metadata.exports);
  if (typeof metadata.version !== "string" || !types) {
    throw referenceError("SDK_DECLARATION_UNAVAILABLE", packageName, "Install a library version that ships TypeScript declarations.");
  }
  const entrypoint = await declarationPath(root, types);
  return { root, version: metadata.version, entrypoint };
}

function exportedTypes(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.types === "string") return value.types;
  for (const condition of ["import", "require", "default"]) {
    const types = exportedTypes(value[condition]);
    if (types) return types;
  }
  return undefined;
}

async function declarationPath(root: string, file: string): Promise<string> {
  const absolute = resolve(root, file);
  if (isAbsolute(file) || !/\.d\.(?:ts|mts|cts)$/.test(file) || !containsPath(root, absolute)) {
    throw referenceError("REFERENCE_PATH_INVALID", file, "Choose a relative declaration file inside the selected package.");
  }
  const canonical = await realpath(absolute);
  if (!containsPath(root, canonical)) {
    throw referenceError("REFERENCE_PATH_INVALID", file, "Declaration symlinks must not leave the selected package.");
  }
  return canonical;
}

export async function listProvisioningLibraries(
  workspaceRoot: string,
  projectDirectory = ".",
): Promise<Record<string, unknown>> {
  const project = await projectPath(workspaceRoot, projectDirectory);
  let metadata: Record<string, unknown>;
  try {
    metadata = await manifest(resolve(project, "package.json"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return {
      manifestStatus: "missing",
      packages: [],
      repair: "Create a package manifest and declare the provisioning libraries imported by the authored TypeScript.",
    };
  }
  const names = new Set<string>();
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const dependencies = metadata[group];
    if (!isObject(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@azure/provisioning-")) names.add(name);
    }
  }
  const packages = await Promise.all([...names].sort().map(async (packageName) => {
    try {
      const installed = await installedPackage(packageName, project);
      return { packageName, installed: true, version: installed.version };
    } catch (error) {
      if (error instanceof IacComposerError && error.diagnostic.code === "SDK_PACKAGE_UNAVAILABLE") {
        return { packageName, installed: false, diagnostic: error.diagnostic };
      }
      throw error;
    }
  }));
  return { manifestStatus: "present", packages };
}

export async function getTypeScriptReference(options: {
  workspaceRoot: string;
  packageName?: string;
  symbol?: string;
  projectDirectory?: string;
  file?: string;
  line?: number;
}): Promise<TypeScriptReference> {
  const packageName = options.packageName ?? "iac-composer";
  if (options.symbol !== undefined && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(options.symbol)) {
    throw referenceError("REFERENCE_SYMBOL_INVALID", options.symbol, "Use a single TypeScript identifier.");
  }
  if (options.line !== undefined &&
      (!options.file || options.symbol !== undefined || !Number.isInteger(options.line) || options.line < 1)) {
    throw referenceError("REFERENCE_ARGUMENT_INVALID", "line", "A positive line number requires a declaration file and no symbol query.");
  }
  const project = await projectPath(options.workspaceRoot, options.projectDirectory ?? ".");
  const installed = await installedPackage(packageName, project);
  const files: string[] = [];
  let truncated = false;
  if (options.file) {
    files.push(await declarationPath(installed.root, options.file));
  } else if (options.symbol) {
    async function collect(directory: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        if (files.length >= maxFiles) { truncated = true; return; }
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else if (entry.isFile() && /\.d\.(?:ts|mts|cts)$/.test(entry.name)) files.push(path);
      }
    }
    await collect(packageName === "iac-composer" ? resolve(installed.root, "dist") : installed.root);
  } else {
    files.push(installed.entrypoint);
  }
  const escaped = options.symbol?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const symbolPattern = escaped
    ? new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`)
    : undefined;
  const declarationPattern = escaped
    ? new RegExp(`\\b(?:class|interface|type|function|const|enum)\\s+${escaped}(?![A-Za-z0-9_$])`)
    : undefined;
  const matches: (TypeScriptReference["matches"][number] & { declaration: boolean })[] = [];
  let totalBytes = 0;
  for (const path of files) {
    const canonical = await declarationPath(installed.root, relative(installed.root, path));
    const size = (await stat(canonical)).size;
    if (size > maxFileBytes || totalBytes + size > maxTotalBytes) {
      truncated = true;
      continue;
    }
    totalBytes += size;
    const lines = (await readFile(canonical, "utf8")).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (symbolPattern ? !symbolPattern.test(lines[index]!) : index !== (options.line ?? 1) - 1) continue;
      const start = symbolPattern ? Math.max(0, index - 2) : index;
      const end = Math.min(lines.length, index + (symbolPattern ? 42 : 80));
      const text = lines.slice(start, end).join("\n");
      const excerpt = text.slice(0, 4000);
      matches.push({
        file: relative(installed.root, canonical).split("\\").join("/"),
        line: start + 1,
        endLine: start + excerpt.split("\n").length,
        excerpt,
        declaration: declarationPattern?.test(lines[index]!) ?? true,
      });
      if (text.length > 4000) truncated = true;
    }
    if (!options.symbol && matches.length === 0) {
      throw referenceError("REFERENCE_LINE_UNAVAILABLE", String(options.line ?? 1), "Select a line within the declaration file and check lookup size limits.");
    }
  }
  matches.sort((left, right) => Number(right.declaration) - Number(left.declaration));
  if (options.symbol && matches.length === 0) {
    throw referenceError(
      truncated ? "REFERENCE_SCAN_LIMIT" : "REFERENCE_SYMBOL_NOT_FOUND",
      options.symbol,
      truncated
        ? "Narrow lookup with a declaration file from the selected library."
        : "Check the installed library/version and query an exported type. Do not invent SDK properties or silently substitute another infrastructure authoring method.",
    );
  }
  return {
    packageName,
    version: installed.version,
    entrypoint: relative(installed.root, installed.entrypoint).split("\\").join("/"),
    declarationFiles: files.slice(0, 20).map((path) => relative(installed.root, path).split("\\").join("/")),
    matches: matches.slice(0, 3).map(({ declaration: _, ...match }) => match),
    truncated: truncated || matches.length > 3 || files.length > 20,
    format: "TypeScript declarations",
  };
}
