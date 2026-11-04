import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { IacComposerError } from "./diagnostics.js";

export interface WorkspacePaths {
  readonly root: string;
  resolveRead(path: string, allowMissing?: boolean): Promise<string>;
  resolveWrite(path: string): Promise<string>;
}

export function containsPath(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

export function workspaceError(
  code: string,
  message: string,
  target: string,
  repair: string,
): IacComposerError {
  return new IacComposerError({
    code,
    category: "configuration",
    message,
    target,
    repair,
  });
}

export async function createWorkspacePaths(root: string): Promise<WorkspacePaths> {
  let directory: string;
  try {
    directory = await realpath(resolve(root));
    if (!(await stat(directory)).isDirectory()) {
      throw new Error("Not a directory.");
    }
  } catch (cause) {
    throw new IacComposerError({
      code: "WORKSPACE_INVALID",
      category: "configuration",
      message: "The configured workspace must be an existing directory.",
      target: root,
      repair: "Register the server with --workspace pointing to the consumer repository.",
    }, { cause });
  }

  function bounded(path: string): string {
    const absolute = resolve(directory, path);
    if (!path.trim() || path.includes("\0") || !containsPath(directory, absolute)) {
      throw workspaceError(
        "WORKSPACE_PATH_INVALID",
        "The requested path must be inside the configured workspace.",
        path,
        "Use a workspace-relative path; do not reference files outside the registered repository.",
      );
    }
    return absolute;
  }

  return {
    root: directory,
    async resolveRead(path, allowMissing = false) {
      const absolute = bounded(path);
      let existing = absolute;
      while (true) {
        try {
          const canonical = await realpath(existing);
          if (!containsPath(directory, canonical)) {
            throw workspaceError(
              "WORKSPACE_PATH_INVALID",
              "A source path resolves outside the configured workspace.",
              path,
              "Remove the out-of-workspace symlink or use a source inside the registered repository.",
            );
          }
          return existing === absolute ? canonical : absolute;
        } catch (error) {
          if (allowMissing && isMissing(error) && existing !== directory) {
            existing = dirname(existing);
            continue;
          }
          if (error instanceof IacComposerError) throw error;
          throw new IacComposerError({
            code: "SOURCE_UNAVAILABLE",
            category: "configuration",
            message: "A required source path could not be resolved.",
            target: path,
            repair: "Create the source file and check its path and read permissions.",
          }, { cause: error });
        }
      }
    },
    async resolveWrite(path) {
      const absolute = bounded(path);
      if (absolute === directory) {
        throw workspaceError(
          "OUTPUT_DIRECTORY_INVALID",
          "Generation cannot write directly into the workspace root.",
          path,
          "Choose a dedicated output subdirectory such as deployment.",
        );
      }
      for (let current = absolute; current !== directory; current = dirname(current)) {
        try {
          if ((await lstat(current)).isSymbolicLink()) {
            throw workspaceError(
              "OUTPUT_SYMLINK_REFUSED",
              "Generation output cannot traverse or replace a symlink.",
              path,
              "Choose a dedicated output directory with no symlinked ancestors or files.",
            );
          }
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
      }
      return absolute;
    },
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
